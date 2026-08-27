import * as path from 'path';
import * as vscode from 'vscode';
import { advanceBaseline } from './core/baselineStore';
import { RetypeEngine } from './core/retype';
import {
  Section,
  SectionOutcome,
  TextChange,
  buildSections,
  claimedCount,
  enclosingSection,
  isClaimed,
  nextUnclaimed,
  outcomeCounts,
  remapSections,
  sectionAt,
  typedBoundary,
} from './core/sections';
import { DebtSource } from './debtSource';
import {
  Removal,
  RemovalMarks,
  deletedLines,
  lineCount,
  removalAnchor,
  removalHover,
  removalRanges,
} from './removalMark';
import { ReviewLog } from './reviewState';
import { TypingFx } from './typingFx';

export const BASELINE_SCHEME = 'copyworkcode-baseline';
export const REMOVED_SCHEME = 'copyworkcode-removed';

/** Workbench commands that flip the active editor's session read-only flag. */
const SET_READONLY = 'workbench.action.files.setActiveEditorReadonlyInSession';
const RESET_READONLY = 'workbench.action.files.resetActiveEditorReadonlyInSession';

/** Left-hand side of the on-demand review diff: the review's baseline, named
 * after whatever the current mode compares against. */
export function baselineUri(file: string, label: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: BASELINE_SCHEME,
    path: `/${path.basename(file)} (${label})`,
    query: file,
  });
}

/**
 * The lines one removal took away, as a document of their own.
 *
 * Removed text has nowhere in the buffer to live, so showing more than a hover
 * holds means giving it a file: a virtual one, keyed by the section that lost
 * the lines, opened in a panel over the line where they used to be. The name
 * keeps the original extension, which is the only thing a peek has to go on
 * when it decides how to colour what it shows.
 */
export function removedUri(
  file: string,
  session: number,
  start: number,
  lines: number
): vscode.Uri {
  return vscode.Uri.from({
    scheme: REMOVED_SCHEME,
    // The review is a directory the name sits in, out of sight of the label the
    // panel shows. It has to be part of the name somewhere: the editor caches a
    // virtual document by its URI and never asks for its content again, and one
    // file reviewed twice can lose different lines at the same offset — the
    // second review must not be served the first one's text.
    path: `/${session}/${deletedLines(lines)} from ${path.basename(file)}`,
    query: String(start),
  });
}

interface Session {
  /** Which review this is, counted from the start of the editor session. Only
   * the removed-lines documents need it, and only to keep two reviews of one
   * file from sharing a name. */
  id: number;
  root: string;
  file: string;
  document: vscode.TextDocument;
  /** What the buffer held when the review opened — the version being reviewed,
   * before the reviewer wrote a word of their own. Kept so a reset can put the
   * file back to it, and re-read whenever the review restarts from new
   * content, since that content is what is under review from then on. */
  original: string;
  sections: Section[];
  /** The section the review is pointing at. Follows the cursor, but is kept
   * across a move to another editor so the highlight doesn't blink away. */
  active?: Section;
  /** True while this review holds the editor's session read-only flag, which
   * is every moment guidance is armed. */
  locked: boolean;
  /** True while the reviewer has editing enabled: guidance stands down, the
   * read-only flag is lifted, and the file is an ordinary editor. */
  editing: boolean;
}

/** Where the cursor is in relation to the review, resolved per keystroke. */
interface Focus {
  editor: vscode.TextEditor;
  cursor: number;
  section: Section;
  /** The cursor is in a section that still owes something and guidance is
   * armed — the only situation in which keystrokes are checked against the
   * target. Anywhere in the section counts: the keystroke lands at the typing
   * position wherever the caret is, and the caret is taken there. */
  guided: boolean;
}

/** What the debt view shows about a file with a review on it. */
export interface ReviewProgress {
  claimed: number;
  total: number;
  /** True for a review being kept rather than run: the reviewer moved to another
   * file, and this one's progress is waiting for them. */
  paused: boolean;
}

/**
 * Drives the guided retype for one file. The review opens the file in a plain
 * editor — not a diff — so the review flow owns the visuals while the editor
 * stays an editor: text still owed is dimmed, the section being worked on
 * carries a highlight and a lens strip with its controls, and the exact next
 * character to type is marked. The baseline diff stays one action away instead
 * of being the surface.
 *
 * The buffer already holds the final content, so a *matched* keystroke inserts
 * nothing and only advances that section's position, letting the dimmed
 * rendering recede as the reviewer types. While guidance is armed the change is
 * reproduced to the letter: a keystroke that doesn't match inserts nothing
 * either, and the editor carries the session read-only flag, so no gesture at
 * all — a paste, a backspace, an undo, a drag — can put text into the file that
 * the reviewer didn't type from the target. A wrong key is a flash and nothing
 * more.
 *
 * Writing their own code is a thing they ask for, not a thing that happens to
 * them: `enableEditing` lifts the read-only flag and stands guidance down, and
 * the file is an ordinary editor again with every convenience back — auto-close,
 * completions, Tab, Enter. `resumeTyping`, on the same key, arms it again and
 * puts the caret back where the section left off so the rest can be typed out.
 * A section whose text they changed while editing is recorded as edited rather
 * than typed. Both directions are one keystroke and neither loses any progress.
 *
 * Sections are a set, not a sequence: each carries its own position, and the
 * active one is whichever contains the cursor. Finishing one still walks the
 * cursor to the next section still owed, so someone who just keeps typing is
 * led straight through the file — but clicking anywhere else hands the editor
 * back immediately. Progress is coverage ("6 of 9 claimed"), not order.
 *
 * Moving to another file keeps where the review got to. The one being left is
 * *parked*: its sections, their positions and its record of the version under
 * review are all kept, and reviewing that file again picks up exactly where it
 * stopped. Only one review is live at a time, which is what an editor can
 * actually support — the read-only flag, the `type` override and the overlay all
 * belong to one document — so a parked review is not a second live one. Nothing
 * of it is on screen, nothing is locked, and the file is an ordinary editor
 * again. Buffer changes still reach it, though, so a formatter or an agent
 * rewriting a file while its review waits moves that review's sections exactly
 * as it would a live one's. It ends only when there is nothing left for it to
 * point at: its document closes, its debt is cleared some other way, or another
 * surface takes the file over.
 *
 * Because edits are real, the buffer changes under the review, and every
 * change — the reviewer's own, a formatter's, an agent's, an undo — is
 * reconciled by remapping the section set (see `core/sections.ts`) rather than
 * ending the review. Only a wholesale replacement of the document (a revert or
 * a reload from disk) re-derives the sections from scratch.
 *
 * Keystrokes are intercepted with a `type` command override, which is what
 * keeps completions, snippets and auto-closing pairs from typing code on the
 * reviewer's behalf. It is held only while guidance is armed and the reviewed
 * file is the active editor; with editing enabled it is dropped outright, so
 * input takes the editor's own path.
 */
export class RetypeController implements vscode.Disposable {
  private session?: Session;
  /** Reviews the reviewer stepped away from, by file. Held for as long as the
   * window lives and never written to disk: positions describe a buffer, and a
   * buffer is only a fact while the editor is open. */
  private parked = new Map<string, Session>();
  /** Guards the async span of start() before `session` exists, so a doubled
   * command invocation (double-click, impatient re-click) can't interleave
   * two setups over the same state. */
  private starting = false;
  /** True across the span of a reset, so the wholesale document replacement it
   * performs is not mistaken for a revert from disk. */
  private resetting = false;
  /** Held only while the review editor is the active one — see
   * `syncTypeOverride`. */
  private typeOverride?: vscode.Disposable;
  /** Set once the override has been reported as unavailable, so a window with
   * another owner of `type` says so once rather than on every editor switch. */
  private overrideLost = false;
  /** Files still flagged session-read-only after their review ended with no
   * editor to run the reset on; cleared when they next become active. */
  private pendingReadonlyReset = new Set<string>();
  private emitter = new vscode.EventEmitter<void>();
  /** Fires when a review finishes, ends, or is otherwise torn down. */
  readonly onDidFinish = this.emitter.event;
  private startEmitter = new vscode.EventEmitter<string>();
  /** Fires with the file once its review is live. Separate from `onDidFinish`
   * because starting one moves no baseline: the queue has to redraw (a row is
   * under review now), but nothing that depends on baselines has gone stale.
   * The file comes with it because a review starting is also the moment every
   * other surface has to let go of that one file. */
  readonly onDidStart = this.startEmitter.event;

  /** Text still owed: kept in the buffer, rendered dimmed until typed over.
   * Dim enough to read as still owed, light enough to actually read — the
   * next character has to be legible, because guidance insists on exactly it. */
  private pending = vscode.window.createTextEditorDecorationType({
    opacity: '0.55',
  });
  /** The section being worked on right now. */
  private currentSection = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
    borderWidth: '0 0 0 2px',
    borderStyle: 'solid',
    borderColor: new vscode.ThemeColor('focusBorder'),
    overviewRulerColor: new vscode.ThemeColor('focusBorder'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  /** A closed section the reviewer wrote in themselves. Marked, because a
   * review's own record of what happened should be visible in the file it
   * happened to, not only in the summary at the end. */
  private takenOver = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderWidth: '0 0 0 2px',
    borderStyle: 'solid',
    borderColor: new vscode.ThemeColor('editorInfo.foreground'),
    overviewRulerColor: new vscode.ThemeColor('editorInfo.foreground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  /** The exact text the next keystroke should produce. Outlined as well as
   * filled, so it is the one thing on the line that cannot be missed — and an
   * outline takes no space, so nothing shifts under the caret. */
  private nextTarget = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.findMatchBackground'),
    outlineWidth: '1px',
    outlineStyle: 'solid',
    outlineColor: new vscode.ThemeColor('focusBorder'),
  });
  /** The active section while editing is enabled. It carries the same box as
   * the armed highlight — where the review is pointing is the same question in
   * both states, and answering it only half the time reads as the highlight
   * being broken — and a different edge colour, because what a keystroke does
   * there is not the same question at all. */
  private editingSection = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
    borderWidth: '0 0 0 2px',
    borderStyle: 'solid',
    borderColor: new vscode.ThemeColor('editorWarning.foreground'),
    overviewRulerColor: new vscode.ThemeColor('editorWarning.foreground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  /** Boundaries where lines were removed. Owns a decoration type per count, so
   * unlike the rest it is a class rather than a single type. */
  private removals = new RemovalMarks();
  /** Animation for accepted keystrokes, fills, and mismatches. Decoration
   * only: it trails the engine and never affects what a keystroke does. */
  private fx = new TypingFx();

  private statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  private sessions = 0;
  private lensEmitter = new vscode.EventEmitter<void>();
  private lensProvider: vscode.Disposable;
  private hoverProvider: vscode.Disposable;
  private changeGuard: vscode.Disposable;
  private closeGuard: vscode.Disposable;
  private focusGuard: vscode.Disposable;
  private selectionGuard: vscode.Disposable;
  private visibilityGuard: vscode.Disposable;
  /** Last value pushed for each context key, so cursor movement doesn't
   * re-issue a setContext per key on every event. */
  private contexts = new Map<string, boolean>();
  /** Signature of what the lens strip last rendered, so it is only asked to
   * re-provide when something in it actually changed. */
  private lensKey = '';
  /** The same, for the decorations. */
  private paintKey = '';
  /** Clock of the last structural notice, to keep them from stacking up when a
   * file is being rewritten repeatedly underneath the review. */
  private lastNote = 0;
  /** Tail of the gesture queue — see `serialize`. */
  private gestures: Promise<unknown> = Promise.resolve();

  constructor(
    private log: ReviewLog,
    private source: DebtSource
  ) {
    // Every content change is reconciled, never fatal: the reviewer's own
    // typing, a formatter, an agent writing the file again, an undo. The
    // section set is moved to match the new offsets and the review continues.
    this.changeGuard = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length === 0) return;
      // Parked reviews are reconciled too. Their offsets go as stale as a live
      // review's when the file moves under them, and they are the ones nobody
      // is watching, which is exactly where a stale one would go unnoticed.
      const s = this.sessionFor(e.document);
      if (s) this.applyChanges(s, e.contentChanges);
    });
    // A closed document is a review with nothing left to point at: its offsets
    // describe a buffer that no longer exists. Closing the tab alone does not
    // end the review — the document outlives it for a moment, and a tab closed
    // by accident is not a decision to abandon the file.
    this.closeGuard = vscode.workspace.onDidCloseTextDocument((document) => {
      const s = this.sessionFor(document);
      if (s) this.drop(s, `${this.which(s)} ended — the file was closed.`);
    });
    this.focusGuard = vscode.window.onDidChangeActiveTextEditor((editor) => {
      this.syncTypeOverride();
      this.updateUi();
      if (
        editor &&
        this.pendingReadonlyReset.delete(editor.document.uri.toString())
      ) {
        void vscode.commands.executeCommand(RESET_READONLY);
      }
    });
    // Which section is active follows the cursor, so moving it is a UI event.
    this.selectionGuard = vscode.window.onDidChangeTextEditorSelection((e) => {
      if (this.session?.document !== e.textEditor.document) return;
      this.snapToTypingPosition();
      this.updateUi();
    });
    this.visibilityGuard = vscode.window.onDidChangeVisibleTextEditors(() =>
      this.updateUi()
    );
    this.lensProvider = vscode.languages.registerCodeLensProvider(
      { scheme: 'file' },
      {
        onDidChangeCodeLenses: this.lensEmitter.event,
        provideCodeLenses: (document) => this.lensesFor(document),
      }
    );
    // The removal hover is a provider rather than a message on the decoration:
    // a decoration hovers where its range is, and a removal's range is the
    // empty end of a line — on a blank one there is nothing there to point at.
    // A provider answers for the whole line the removal is marked at, which is
    // the line a reader would aim for anyway.
    this.hoverProvider = vscode.languages.registerHoverProvider(
      { scheme: 'file' },
      { provideHover: (document, position) => this.removalHoverAt(document, position) }
    );
  }

  get reviewing(): boolean {
    return this.session !== undefined;
  }

  async start(root: string, file: string): Promise<void> {
    if (this.starting) {
      return; // doubled invocation of the same gesture — first one wins
    }
    if (this.session?.file === file) {
      // Already the live review: the gesture means "take me back to it".
      await this.jumpToCurrent();
      return;
    }
    // The gate covers the handover too — parking the previous review awaits,
    // and a second click during that window would start its own setup alongside
    // this one.
    this.starting = true;
    try {
      if (this.session) await this.park(this.session);
      // Coming back to a file the reviewer left part way through is not a new
      // review of it: it is the same one, picked up where they stopped.
      if (await this.resume(file)) return;
      await this.startLocked(root, file);
    } finally {
      this.starting = false;
    }
  }

  /**
   * Set a review down without ending it, because the reviewer asked for another
   * file. Everything on screen goes — the overlay, the lens strip, the status
   * bar — and the read-only flag lifts, so the file being left behind is an
   * ordinary editor rather than a document that refuses to be typed in for
   * reasons nothing is showing. What stays is the state: the sections, what each
   * one has covered, and the version the review is against.
   */
  private async park(s: Session): Promise<void> {
    this.session = undefined;
    await this.disarm(s);
    await this.teardown();
    this.parked.set(s.file, s);
    void vscode.window.setStatusBarMessage(
      `CopyWorkCode: review of ${path.basename(s.file)} paused at ` +
        `${claimedCount(s.sections)}/${s.sections.length} claimed — ` +
        'opening it again picks up here.',
      6000
    );
  }

  /**
   * Pick a parked review back up: the same sections with the same positions, the
   * caret where it left off, and guidance armed again unless it was parked with
   * editing enabled.
   *
   * Answers whether there was one to pick up, so the caller can start a fresh
   * review instead. Two things make a parked review unusable rather than merely
   * stale, and both are checked here rather than papered over: a document that
   * has closed since, whose offsets describe a buffer that no longer exists, and
   * a file with nothing left behind it to compare against. Everything else — the
   * file rewritten, reformatted, reverted while it waited — was reconciled as it
   * happened, the same way it is for a live review.
   */
  private async resume(file: string): Promise<boolean> {
    const s = this.parked.get(file);
    if (!s) return false;
    this.parked.delete(file);
    if (s.document.isClosed || this.source.baselineFor(file) === undefined) {
      this.emitter.fire();
      return false;
    }
    this.session = s;
    this.overrideLost = false;
    await vscode.window.showTextDocument(s.document, { preview: false });
    this.syncTypeOverride();
    if (!s.editing && !this.typeOverride) {
      // The answer a review that cannot arm at all gets — except that here there
      // is progress to protect, so it goes back where it was rather than being
      // spent on a review that could not check a keystroke.
      this.session = undefined;
      this.parked.set(file, s);
      void vscode.window.showErrorMessage(
        'CopyWorkCode: another extension intercepts typing; guided retype is unavailable.'
      );
      return true;
    }
    this.fx.bind(s.document);
    if (!s.editing) await this.arm(s);
    await this.jumpToCurrent();
    this.startEmitter.fire(file);
    void vscode.window.setStatusBarMessage(
      `CopyWorkCode: back in ${path.basename(s.file)} at ` +
        `${claimedCount(s.sections)}/${s.sections.length} claimed.`,
      4000
    );
    return true;
  }

  /** The review a document belongs to, live or parked. */
  private sessionFor(document: vscode.TextDocument): Session | undefined {
    if (this.session?.document === document) return this.session;
    for (const parked of this.parked.values()) {
      if (parked.document === document) return parked;
    }
    return undefined;
  }

  /** Every review this controller is holding, the live one first. */
  private *reviews(): Iterable<Session> {
    if (this.session) yield this.session;
    yield* this.parked.values();
  }

  /** How a message names a review the reviewer may not be looking at. */
  private which(s: Session): string {
    return this.session === s
      ? `review of ${path.basename(s.file)}`
      : `paused review of ${path.basename(s.file)}`;
  }

  /**
   * End a review outright, live or parked. A parked one has nothing on screen to
   * take down, but it still says so: progress the reviewer meant to come back to
   * is exactly the kind of thing that must not vanish without a word.
   */
  private drop(s: Session, message: string): void {
    if (this.session === s) {
      void this.stop(message);
      return;
    }
    this.parked.delete(s.file);
    this.note(message);
    this.emitter.fire();
  }

  private async startLocked(root: string, file: string): Promise<void> {
    const baseline = this.source.baselineFor(file);
    if (baseline === undefined) {
      void vscode.window.showInformationMessage(
        `CopyWorkCode: nothing to compare this file against (${this.source.baselineLabel}).`
      );
      return;
    }

    const document = await vscode.workspace.openTextDocument(file);
    const current = document.getText();
    const sections = buildSections(baseline, current);

    await vscode.window.showTextDocument(document, { preview: false });

    if (sections.length === 0) {
      // Line-ending or whitespace-normalization drift only: nothing to walk.
      // No session exists to protect, and the notification can stay pending
      // indefinitely — release the start gate before awaiting it.
      this.starting = false;
      const action = await vscode.window.showInformationMessage(
        'CopyWorkCode: only line-ending changes since the last review. Mark as reviewed?',
        'Mark Reviewed'
      );
      if (action === 'Mark Reviewed') {
        advanceBaseline(root, file, current);
        this.log.add({
          file,
          at: new Date().toISOString(),
          outcome: 'typed',
          hunksTyped: 0,
          hunksSkipped: 0,
        });
        this.emitter.fire();
      }
      return;
    }

    this.session = {
      id: ++this.sessions,
      root,
      file,
      document,
      original: current,
      sections,
      locked: false,
      editing: false,
    };
    this.overrideLost = false;
    this.syncTypeOverride();
    if (!this.typeOverride) {
      // Another extension owns `type` (e.g. a modal-editing plugin): retype
      // can't validate keystrokes, so don't pretend to review.
      this.session = undefined;
      void vscode.window.showErrorMessage(
        'CopyWorkCode: another extension intercepts typing; guided retype is unavailable.'
      );
      return;
    }

    if (startEditing()) {
      // Opt-in: hand the editor over before the first keystroke, for someone
      // who mostly rewrites what the agent wrote. The override was just taken
      // and is dropped again here: the probe above is the only way to find out
      // whether guidance *could* run, and the answer matters even when it isn't
      // running yet.
      this.session.editing = true;
      this.syncTypeOverride();
    } else {
      // Guidance starts armed: with the editor read-only for the session, every
      // gesture other than a matched keystroke is inert, so nothing reaches the
      // buffer that the matching engine didn't authorise. Ctrl+E is how the
      // reviewer asks for more than that.
      await this.arm(this.session);
    }

    this.fx.bind(document);
    const first = nextUnclaimed(sections);
    if (first) {
      this.session.active = first;
      this.moveCursorTo(first.start, vscode.TextEditorRevealType.InCenter);
    }
    this.updateUi();
    this.startEmitter.fire(file);
  }

  /**
   * Hold the `type` override only while the reviewed file is the active editor.
   * The override is global — every keystroke in the window would otherwise take
   * a round trip through here just to be handed back to the editor — and a
   * review now outlives its tab, so it can be the active editor for a small
   * fraction of the time it exists. Typing in any other file costs nothing.
   */
  private syncTypeOverride(): void {
    const s = this.session;
    const wanted =
      s !== undefined &&
      !s.editing &&
      vscode.window.activeTextEditor?.document === s.document;
    if (wanted === (this.typeOverride !== undefined)) return;
    if (!wanted) {
      this.typeOverride?.dispose();
      this.typeOverride = undefined;
      return;
    }
    try {
      this.typeOverride = vscode.commands.registerCommand('type', (args) =>
        this.onType(args)
      );
    } catch {
      // Somebody else claimed `type` while the review was in the background.
      // Nothing to type against any more, but the overlay still reads as a
      // review, so say so — once.
      if (!this.overrideLost) {
        this.overrideLost = true;
        void vscode.window.showWarningMessage(
          'CopyWorkCode: another extension took over typing; this review can no longer check keystrokes.'
        );
      }
    }
  }

  // --- typing -----------------------------------------------------------------

  /**
   * Run one gesture at a time, in arrival order.
   *
   * Every gesture here reads a section's position, awaits, then writes it back,
   * so two of them overlapping would decide from the same position and the
   * second would act on a stale offset. Whether the editor can actually deliver
   * a keystroke while the previous one is still being answered is not something
   * this code should depend on either way: commands driven from the extension
   * arrive sequentially, so the test suite cannot demonstrate the overlap, and
   * the guarantee is cheap enough to make here rather than assume. Queueing
   * costs nothing when nothing is pending, which is the usual case.
   *
   * Only the outermost entry points go through this: nesting one inside another
   * would wait for itself.
   */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.gestures.then(work, work);
    this.gestures = next.catch(() => undefined);
    return next;
  }

  /**
   * Every printable keystroke in the window while a review is live. Only the
   * ones landing exactly where a section owes its next character are checked;
   * everything else is the editor's own business and is passed through.
   */
  private onType(args: { text: string }): Promise<void> {
    return this.serialize(() => this.handleType(args));
  }

  private async handleType(args: { text: string }): Promise<void> {
    const focus = this.focus();
    if (!focus || !focus.guided) {
      await vscode.commands.executeCommand('default:type', args);
      return;
    }
    const section = focus.section;
    const engine = new RetypeEngine(section.target, section.position);
    const from = engine.position;

    if (engine.handleInput(args.text ?? '').kind === 'reject') {
      this.reject(section);
      return;
    }
    section.position = engine.position;
    section.touched = true;
    this.animateRun(section, from, engine.position, 'strike');
    await this.settle(section);
  }

  /**
   * A keystroke that isn't the character this section owes. Nothing happens to
   * the buffer: an armed review reproduces the change to the letter, so a wrong
   * key stays wrong however many times it is repeated and the file cannot drift
   * a character away from the target by accident. What the reviewer gets instead
   * is the flash, and the key that hands them the editor — the moment a wrong
   * key fires is exactly when they want to be told about it.
   */
  private reject(section: Section): void {
    this.flashMismatch(section);
    this.updateUi('wrong key — Ctrl+E to write here');
  }

  /**
   * Hand the editor back. The read-only flag lifts, guidance stands down, the
   * `type` override is dropped so completions, auto-close, Tab and Enter are
   * the editor's own again, and the reviewer can write, erase, paste and
   * reformat anywhere in the file.
   *
   * Nothing about the review is given up: every section keeps its position,
   * what is still owed stays dimmed, and changes landing in the buffer are
   * reconciled exactly as they are the rest of the time. This is a pause, not
   * an exit.
   */
  enableEditing(): Promise<void> {
    return this.serialize(async () => {
      const s = this.session;
      if (!s || s.editing) return;
      await this.showReview(s);
      s.editing = true;
      await this.disarm(s);
      this.syncTypeOverride();
      this.updateUi();
    });
  }

  /**
   * Arm guidance again and put the caret back where the section it was working
   * on left off, so the rest of the change can be typed out from there without
   * hunting for the position by hand.
   *
   * Whatever was written is saved on the way through, while the file is still
   * writable. An armed review cannot dirty the buffer — a matched keystroke
   * inserts nothing — and a session-read-only editor refuses a save, so without
   * this the reviewer's own work would sit in a buffer they cannot write until
   * the review ends. Saving here keeps disk and buffer in step for as long as
   * guidance holds the file, and format-on-save lands before the flag goes back
   * on, where the remapping treats it like any other outside edit.
   */
  resumeTyping(): Promise<void> {
    return this.serialize(async () => {
      const s = this.session;
      if (!s || !s.editing) return;
      await this.showReview(s);
      s.editing = false;
      if (s.document.isDirty) {
        try {
          await s.document.save();
        } catch {
          // Nothing to do about a save that won't go through (the file may be
          // gone, or read-only on disk); the review carries on regardless.
        }
      }
      await this.arm(s);
      this.syncTypeOverride();
      const section = this.activeSection() ?? nextUnclaimed(s.sections);
      if (section) {
        s.active = section;
        this.moveCursorTo(typedBoundary(section));
      }
      this.updateUi();
    });
  }

  /**
   * Take and release the editor's session read-only flag — how "guidance is
   * armed" is said to the editor itself. Printable input still reaches the
   * `type` override, because the editor dispatches `type` before its read-only
   * check, which is exactly the split a review wants: matched keystrokes work,
   * every other way of changing the file does not.
   *
   * Both workbench commands act on the active editor, so both gestures bring
   * the review into focus first. Releasing can also happen when the review is
   * already over and its tab gone; that case is deferred until the file is next
   * active, or the file would stay unwritable for the rest of the session.
   */
  private async arm(s: Session): Promise<void> {
    if (s.locked || vscode.window.activeTextEditor?.document !== s.document) {
      return;
    }
    s.locked = true;
    await vscode.commands.executeCommand(SET_READONLY);
  }

  private async disarm(s: Session): Promise<void> {
    if (!s.locked) return;
    s.locked = false;
    if (
      vscode.window.activeTextEditor?.document === s.document &&
      this.reviewTabOpen(s.document)
    ) {
      await vscode.commands.executeCommand(RESET_READONLY);
    } else {
      this.pendingReadonlyReset.add(s.document.uri.toString());
    }
  }

  private async showReview(s: Session): Promise<void> {
    if (vscode.window.activeTextEditor?.document === s.document) return;
    await vscode.window.showTextDocument(s.document, { preview: false });
  }

  /** Enter is dispatched as an editor command, not `type` input, so it is
   * rebound while guidance is on to route through the engine and snap the
   * target's whitespace. Everywhere else it keeps its normal behaviour. */
  typeEnter(): Promise<void> {
    return this.serialize(async () => {
      if (!this.focus()?.guided) {
        await vscode.commands.executeCommand('default:type', { text: '\n' });
        return;
      }
      await this.handleType({ text: '\n' });
    });
  }

  /**
   * Fill in the next word instead of typing it: the pending whitespace plus a
   * run of identifier characters, or a run of adjacent symbols. Bound to Tab,
   * and to the right arrow — where there is nowhere useful to move anyway,
   * since everything to the right is text still owed. Both keep their normal
   * behaviour whenever guidance is off.
   */
  fillNextWord(): Promise<void> {
    return this.serialize(async () => {
      const focus = this.focus();
      if (!focus?.guided) {
        await vscode.commands.executeCommand('cursorRight');
        return;
      }
      await this.fill(focus.section, (engine) => engine.fillWord());
    });
  }

  fillNextLine(): Promise<void> {
    return this.serialize(async () => {
      const section = this.activeSection();
      if (!section) return;
      if (section.kind === 'confirm') {
        await this.claim(section, 'confirmed');
        return;
      }
      await this.fill(section, (engine) => engine.fillLine());
    });
  }

  /** Fill in the whole section and move on, recorded as skipped. */
  skipSection(): Promise<void> {
    return this.serialize(async () => {
      const section = this.activeSection();
      if (!section) return;
      if (section.kind === 'confirm') {
        await this.claim(section, 'confirmed');
        return;
      }
      const from = section.position;
      section.position = section.target.length;
      section.touched = false;
      this.animateRun(section, from, section.position, 'wipe');
      await this.settle(section);
    });
  }

  /** Acknowledge a deletion-only section (the lens button's command). */
  confirmSection(): Promise<void> {
    return this.serialize(async () => {
      const section = this.activeSection();
      if (!section || section.kind !== 'confirm') return;
      await this.claim(section, 'confirmed');
    });
  }

  private async fill(
    section: Section,
    run: (engine: RetypeEngine) => string
  ): Promise<void> {
    const engine = new RetypeEngine(section.target, section.position);
    const from = engine.position;
    run(engine);
    section.position = engine.position;
    this.animateRun(section, from, engine.position, 'wipe');
    await this.settle(section);
  }

  /** A section's position moved: follow it with the cursor, and close the
   * section out when its target is fully covered. */
  private async settle(section: Section): Promise<void> {
    if (section.position < section.target.length) {
      this.moveCursorTo(typedBoundary(section));
      this.updateUi();
      return;
    }
    await this.claim(section, outcomeOf(section));
  }

  /**
   * Record how a section was dealt with and lead the cursor to the next one
   * still owed. Reaching the end this way completes the review — a reviewer who
   * just keeps typing never has to ask for the next section or for the finish.
   */
  private async claim(section: Section, outcome: SectionOutcome): Promise<void> {
    const s = this.session;
    if (!s) return;
    section.outcome = outcome;
    const next = nextUnclaimed(s.sections, section.end);
    if (!next) {
      await this.finish();
      return;
    }
    s.active = next;
    this.moveCursorTo(typedBoundary(next));
    this.updateUi();
  }

  // --- navigation -------------------------------------------------------------

  /** Bring the viewport and cursor to the section the review is pointing at,
   * or to the next one still owed if the cursor has wandered off. */
  async jumpToCurrent(): Promise<void> {
    const s = this.session;
    if (!s) return;
    await vscode.window.showTextDocument(s.document, { preview: false });
    const target = this.activeSection() ?? nextUnclaimed(s.sections);
    if (!target) {
      this.updateUi();
      return;
    }
    s.active = target;
    this.moveCursorTo(typedBoundary(target), vscode.TextEditorRevealType.InCenter);
    this.updateUi();
  }

  /** Start work on one specific section — the lens action on a section the
   * reviewer hasn't reached yet. */
  async focusSection(offset: number): Promise<void> {
    const s = this.session;
    if (!s || typeof offset !== 'number') return;
    const section = sectionAt(s.sections, offset);
    if (!section) return;
    await vscode.window.showTextDocument(s.document, { preview: false });
    s.active = section;
    this.moveCursorTo(typedBoundary(section));
    this.updateUi();
  }

  /** The on-demand baseline diff — context, not the review surface. */
  async showDiff(): Promise<void> {
    const s = this.session;
    if (!s) return;
    const label = this.source.baselineLabel;
    await vscode.commands.executeCommand(
      'vscode.diff',
      baselineUri(s.file, label),
      s.document.uri,
      `${path.basename(s.file)} (diff vs ${label})`,
      { preview: true }
    );
  }

  /** One section's removal, in the shape the mark and the hover both take. */
  private removalOf(s: Session, section: Section): Removal {
    return {
      line: s.document.positionAt(section.start).line,
      text: section.removedLines,
      atEnd: section.removedAtEnd,
      replaced: section.kind === 'type',
    };
  }

  /** Sections whose removal is still worth marking: the ones the review has
   * yet to claim. A claimed section's mark has done its job, and the file's
   * history is the diff's business rather than the overlay's. */
  private markedRemovals(s: Session): Section[] {
    return s.sections.filter(
      (section) => section.removedLines.length > 0 && !isClaimed(section)
    );
  }

  /**
   * The removed lines behind the mark on this line, if there are any.
   *
   * Asked for every hover in every file, so it answers nothing at all unless
   * the position is in the live review and lands on a line a removal was
   * marked at. It answers for exactly the removals that are marked: a hover
   * behind nothing visible is a feature only the person who wrote it knows is
   * there.
   */
  private removalHoverAt(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Hover | undefined {
    const s = this.session;
    if (!s || document !== s.document) return undefined;
    for (const section of this.markedRemovals(s)) {
      const removal = this.removalOf(s, section);
      if (removalAnchor(document, removal)?.line !== position.line) continue;
      // The link carries the section's offset rather than the section: a
      // command URI is text, and the offset is what survives the round trip.
      const showAll = vscode.Uri.parse(
        `command:copyworkcode.peekRemoved?${encodeURIComponent(
          JSON.stringify([section.start])
        )}`
      );
      return removalHover(document, removal, showAll);
    }
    return undefined;
  }

  /** The whole removal, in a panel over the line it happened at — where the
   * hover stops. Opened as a peek rather than an editor because the point is
   * to read the lines against the code that replaced them, without leaving
   * it. */
  async peekRemoved(start: number): Promise<void> {
    const s = this.session;
    if (!s) return;
    const section = s.sections.find((candidate) => candidate.start === start);
    if (!section || section.removedLines.length === 0) return;
    const anchor = removalAnchor(s.document, this.removalOf(s, section));
    if (!anchor) return;
    await vscode.window.showTextDocument(s.document, { preview: false });
    await vscode.commands.executeCommand(
      'editor.action.peekLocations',
      s.document.uri,
      new vscode.Position(anchor.line, 0),
      [
        new vscode.Location(
          removedUri(s.file, s.id, section.start, section.removedLines.length),
          new vscode.Range(0, 0, 0, 0)
        ),
      ],
      'peek'
    );
  }

  /** Content for a `copyworkcode-removed:` document: the lines the section at
   * the URI's offset lost. Empty once that section is gone — the review it
   * belonged to ended, or an edit moved it — which is the honest answer. */
  removedTextFor(uri: vscode.Uri): string {
    for (const s of this.reviews()) {
      for (const section of s.sections) {
        if (section.removedLines.length === 0) continue;
        // Matched by the whole name a section's document would be given, not by
        // the offset alone: with parked reviews holding sections of their own, an
        // offset no longer says which review's removal is being asked for.
        const mine = removedUri(
          s.file,
          s.id,
          section.start,
          section.removedLines.length
        );
        if (mine.path === uri.path && mine.query === uri.query) {
          return `${section.removedLines.join('\n')}\n`;
        }
      }
    }
    return '';
  }

  /** Coverage of this file's review, live or parked, for the debt view. */
  progressFor(file: string): ReviewProgress | undefined {
    const s = this.session?.file === file ? this.session : this.parked.get(file);
    if (!s) return undefined;
    return {
      claimed: claimedCount(s.sections),
      total: s.sections.length,
      paused: s !== this.session,
    };
  }

  /**
   * Start this file's review over: every section owed again from zero, and the
   * file itself back to the version that was handed over for review.
   *
   * Both halves are needed for the gesture to mean anything. Typing writes
   * nothing to the buffer, so clearing the positions alone would leave the
   * reviewer's own rewrites sitting in the file and immediately re-derived as
   * sections — a reset that hands back a different change from the one it was
   * asked to redo. Restoring the text is what makes the second pass the same
   * pass. It is also the one thing in the review that destroys work, so it is
   * the one thing that asks first.
   */
  resetReview(file?: string): Promise<void> {
    return this.serialize(async () => {
      // Resetting a review the reviewer walked away from is a way of asking for
      // it back, with nothing claimed. It has to come back first: the reset
      // rewrites the file and moves the caret, which is not something to do to a
      // document nothing is showing.
      if (file !== undefined && this.session?.file !== file && this.parked.has(file)) {
        if (this.starting) return;
        this.starting = true;
        try {
          if (this.session) await this.park(this.session);
          await this.resume(file);
        } finally {
          this.starting = false;
        }
      }
      const s = this.session;
      if (!s || (file !== undefined && s.file !== file)) {
        void vscode.window.setStatusBarMessage(
          'CopyWorkCode: nothing to reset — that file is not being reviewed right now.',
          4000
        );
        return;
      }
      // Asked only when there is something to lose. Clearing the positions
      // destroys no text — it is the gesture the reviewer just asked for, and
      // a dialog in front of it would be a dialog in front of every reset.
      // Throwing away what they wrote is a different thing entirely.
      const written = s.document.getText() !== s.original;
      if (written) {
        const answer = await vscode.window.showWarningMessage(
          `Reset the review of ${path.basename(s.file)}?`,
          {
            modal: true,
            detail:
              'Every section goes back to unreviewed, and the file goes back to the version being reviewed — anything you wrote here yourself is discarded.',
          },
          'Reset'
        );
        if (answer !== 'Reset' || this.session !== s) return;
      }

      this.resetting = true;
      try {
        await this.showReview(s);
        // The read-only flag refuses an edit and a save alike, so it comes off
        // before either and goes back on at the end.
        await this.disarm(s);
        if (written) {
          const edit = new vscode.WorkspaceEdit();
          edit.replace(
            s.document.uri,
            new vscode.Range(
              s.document.positionAt(0),
              s.document.positionAt(s.document.getText().length)
            ),
            s.original
          );
          await vscode.workspace.applyEdit(edit);
          try {
            await s.document.save();
          } catch {
            // Disk may be unwritable; the buffer is what the review works on.
          }
        }
        if (!this.rebuild(s)) return;
      } finally {
        this.resetting = false;
      }
      if (!s.editing) await this.arm(s);
      this.syncTypeOverride();
      const first = nextUnclaimed(s.sections);
      if (first) {
        s.active = first;
        this.moveCursorTo(first.start, vscode.TextEditorRevealType.InCenter);
      }
      this.updateUi();
      // The queue prints this review's coverage on its row, and it just went
      // back to nothing.
      this.startEmitter.fire(s.file);
      void vscode.window.setStatusBarMessage(
        `CopyWorkCode: review of ${path.basename(s.file)} reset — ${
          s.sections.length
        } section(s) to review again.`,
        5000
      );
    });
  }

  /**
   * Drop the review of a file because it is no longer this surface's to review:
   * its debt was cleared some other way (marked reviewed from the view, or
   * auto-skipped), or another surface took the file over. `message` says which,
   * since the reviewer is owed a reason for a review ending under them.
   */
  async forget(file: string, message?: string): Promise<void> {
    const s = this.session?.file === file ? this.session : this.parked.get(file);
    if (!s) return;
    const reason =
      message ?? `${this.which(s)} ended — it was marked reviewed without typing.`;
    if (s === this.session) {
      await this.stop(reason);
      return;
    }
    this.drop(s, reason);
  }

  // --- ending -----------------------------------------------------------------

  /**
   * Stop reviewing without recording an outcome. Unlike the read-only era there
   * is nothing to restore: whatever the reviewer typed or rewrote is already in
   * the file, and the file's debt is recomputed from its content the next time
   * the queue is read.
   */
  abort(message?: string): Promise<void> {
    return this.serialize(async () => {
      if (!this.session) return;
      await this.stop(
        message ??
          'review stopped and its progress discarded. Your edits stay in the ' +
            'file; the debt stays too.'
      );
    });
  }

  private async stop(message: string): Promise<void> {
    const s = this.session;
    if (!s) return;
    this.session = undefined;
    await this.disarm(s);
    await this.teardown();
    void vscode.window.setStatusBarMessage(`CopyWorkCode: ${message}`, 6000);
  }

  /** The finish as a gesture — the command, the button and the status bar. The
   * internal path into `finish` is already inside a queued gesture. */
  finishReview(): Promise<void> {
    return this.serialize(() => this.finish());
  }

  /**
   * Every section is accounted for. The document is saved and its baseline
   * advanced to what the buffer holds now — which, with real edits in play, is
   * deliberately the reviewer's version of the file rather than the agent's:
   * the baseline records what was reviewed and accepted, so anything they
   * rewrote is not handed straight back as debt on the next pass.
   */
  private async finish(): Promise<void> {
    const s = this.session;
    if (!s) return;
    const owed = s.sections.length - claimedCount(s.sections);
    if (owed > 0) {
      void vscode.window.setStatusBarMessage(
        `CopyWorkCode: ${owed} section(s) still owed — Alt+J goes to the next one.`,
        4000
      );
      return;
    }
    this.session = undefined;
    const counts = outcomeCounts(s.sections);
    // Read-only must lift before the save — a session-read-only editor may
    // refuse it.
    await this.disarm(s);
    try {
      await s.document.save();
    } catch {
      // The file may be gone from disk. The baseline still has to move, or the
      // review that just happened would be owed all over again.
    }
    advanceBaseline(s.root, s.file, s.document.getText());
    this.log.add({
      file: s.file,
      at: new Date().toISOString(),
      outcome:
        counts.typed + counts.confirmed + counts.edited > 0 ? 'typed' : 'skipped',
      hunksTyped: counts.typed,
      hunksSkipped: counts.skipped,
      hunksConfirmed: counts.confirmed,
      hunksEdited: counts.edited,
    });
    await this.teardown();

    const parts = [`${counts.typed} typed`, `${counts.skipped} skipped`];
    if (counts.confirmed > 0) parts.push(`${counts.confirmed} deletion(s) confirmed`);
    if (counts.edited > 0) parts.push(`${counts.edited} written yourself`);
    // Deliberately not awaited. A review usually finishes on a keystroke, and
    // that keystroke's own command is still on the stack: a notification with a
    // button stays up until it is dismissed, so awaiting it here would leave
    // typing blocked behind a dialog nobody is looking at.
    void vscode.window
      .showInformationMessage(
        `CopyWorkCode: ${path.basename(s.file)} reviewed — ${parts.join(', ')}.`,
        'Next file'
      )
      .then((action) => {
        if (action === 'Next file') void this.reviewNextFile(s.root, s.file);
      });
  }

  /**
   * Move to the next file in the queue: the row after `after` (or after the
   * file under review), wrapping around at the end.
   */
  async reviewNextFile(root: string, after?: string): Promise<void> {
    const rows = this.source.rows();
    if (rows.length === 0) {
      void vscode.window.setStatusBarMessage(
        'CopyWorkCode: nothing left in the review queue.',
        4000
      );
      return;
    }
    const from = after ?? this.session?.file;
    const at = from ? rows.findIndex((row) => row.file === from) : -1;
    await this.start(root, rows[(at + 1) % rows.length].file);
  }

  private async teardown(): Promise<void> {
    this.typeOverride?.dispose();
    this.typeOverride = undefined;
    this.statusBar.hide();
    this.fx.clear();
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.pending, []);
      editor.setDecorations(this.currentSection, []);
      editor.setDecorations(this.takenOver, []);
      editor.setDecorations(this.editingSection, []);
      editor.setDecorations(this.nextTarget, []);
      this.removals.apply(editor);
    }
    await this.setContext('copyworkcode.reviewing', false);
    await this.setContext('copyworkcode.reviewEditorFocused', false);
    await this.setContext('copyworkcode.sectionActive', false);
    await this.setContext('copyworkcode.guided', false);
    await this.setContext('copyworkcode.editing', false);
    await this.setContext('copyworkcode.reviewComplete', false);
    this.lensKey = '';
    this.paintKey = '';
    this.lensEmitter.fire();
    this.emitter.fire();
  }

  /** True while any tab still shows the reviewed document — as a plain
   * editor or as the modified side of the on-demand diff. */
  private reviewTabOpen(document: vscode.TextDocument): boolean {
    const target = document.uri.toString();
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (input instanceof vscode.TabInputText && input.uri.toString() === target) {
          return true;
        }
        if (
          input instanceof vscode.TabInputTextDiff &&
          input.modified.toString() === target
        ) {
          return true;
        }
      }
    }
    return false;
  }

  // --- buffer changes ---------------------------------------------------------

  /**
   * Reconcile the section set with what just happened to the buffer. This is
   * the whole reason the review can live in an editable editor: no change is
   * foreign any more, so none of them ends the review, and none of them is
   * announced — a file being written repeatedly underneath a review would turn
   * any notice into a stream of them.
   *
   * A wholesale replacement is the one exception. A revert or a reload from disk
   * arrives as a single change covering the document and carries no information
   * about where the old text went, so remapping it would collapse every section
   * onto one range. Those re-derive the sections instead.
   */
  private applyChanges(
    s: Session,
    contentChanges: readonly vscode.TextDocumentContentChangeEvent[]
  ): void {
    // A reset writes the whole document itself and rebuilds once it is done.
    // Left to this path it would look exactly like a revert from disk, and be
    // announced as one. Only the review being reset is exempt: a parked one
    // whose file happens to change in that window is an ordinary change.
    if (this.resetting && this.session === s) return;
    const claimedBefore = claimedCount(s.sections);
    const changes = contentChanges.map((change) => ({
      from: change.rangeOffset,
      to: change.rangeOffset + change.rangeLength,
      text: change.text,
    }));
    const after = s.document.getText();
    const before =
      after.length -
      changes.reduce((n, c) => n + c.text.length - (c.to - c.from), 0);

    if (
      changes.length === 1 &&
      changes[0].from === 0 &&
      changes[0].to === before &&
      before > 0
    ) {
      this.rebuild(
        s,
        this.session === s
          ? 'the file was replaced — the review restarted from its new content.'
          : `${path.basename(s.file)} was replaced — its paused review restarted ` +
            'from the new content.'
      );
      return;
    }
    if (s.editing) markHandEdited(s.sections, changes);
    remapSections(s.sections, changes, after);
    if (s.active && isClaimed(s.active)) s.active = undefined;
    if (this.session === s) {
      this.updateUi();
    } else if (claimedCount(s.sections) !== claimedBefore) {
      // A parked review draws nothing, so the only thing left to bring up to
      // date is the queue row printing its coverage — and only if that moved.
      this.emitter.fire();
    }
  }

  /**
   * Re-derive the sections for a document that was replaced under the review —
   * by a revert, a reload from disk, or a reset. Whatever the buffer holds now
   * is what is under review from here on, so the record of the version being
   * reviewed moves with it.
   */
  private rebuild(s: Session, note?: string): boolean {
    const baseline = this.source.baselineFor(s.file);
    if (baseline === undefined) {
      this.drop(
        s,
        `${this.which(s)} ended — there is nothing to compare it against any more.`
      );
      return false;
    }
    s.original = s.document.getText();
    s.sections = buildSections(baseline, s.original);
    s.active = undefined;
    if (s.sections.length === 0) {
      this.drop(s, `${this.which(s)} ended — there is nothing left in it to review.`);
      return false;
    }
    if (note) this.note(note);
    const first = nextUnclaimed(s.sections);
    if (first) s.active = first;
    if (this.session === s) this.updateUi();
    else this.emitter.fire();
    return true;
  }

  /** A throttled aside for something structural the reviewer should know about.
   * Never a notification: a dialog per event would be worse than the event. */
  private note(message: string): void {
    const now = Date.now();
    if (now - this.lastNote < 4000) return;
    this.lastNote = now;
    void vscode.window.setStatusBarMessage(`CopyWorkCode: ${message}`, 5000);
  }

  // --- cursor and focus -------------------------------------------------------

  /**
   * Where the cursor is in relation to the review.
   *
   * Guidance covers the whole of a section the review still owes, rather than
   * the single offset its next character sits at. Requiring the caret to be
   * exactly there made the most ordinary gesture there is (click into the
   * changed code, start typing) fall through to the plain editor, so the
   * keystrokes went in *beside* the text they were meant to reproduce instead
   * of consuming it. Anywhere in the section, typing is matched; the keystroke
   * applies at the typing position wherever the caret happens to be, and
   * `snapToTypingPosition` puts the caret there so the character always appears
   * where it is being typed.
   *
   * That includes the part of the section already covered. Clicking back into
   * text that has been typed is a click into a section still being worked on,
   * and the review has one answer for that wherever in the section it lands:
   * take the caret to where the typing goes and be ready for the next key.
   *
   * What is left is the dimmed run against everything else. Inside it, typing
   * is matched; anywhere else, while guidance is armed, typing is inert — the
   * override hands the keystroke back and the read-only flag catches it — and
   * the way to write there is Ctrl+E, which stands guidance down wholesale. A
   * selection or a second cursor is a gesture about the file, not about the one
   * character a section is waiting for, and is left alone either way.
   */
  private focus(): Focus | undefined {
    const s = this.session;
    const editor = vscode.window.activeTextEditor;
    if (!s || !editor || editor.document !== s.document) return undefined;
    const cursor = s.document.offsetAt(editor.selection.active);
    const section = sectionAt(s.sections, cursor);
    if (!section) return undefined;
    const guided =
      !s.editing &&
      section.kind === 'type' &&
      !section.free &&
      editor.selection.isEmpty &&
      editor.selections.length === 1;
    return { editor, cursor, section, guided };
  }

  /** The section the review is pointing at: the one under the cursor, or the
   * last one that was, so section actions still work after a glance elsewhere. */
  private activeSection(focus = this.focus()): Section | undefined {
    const s = this.session;
    if (!s) return undefined;
    const under = focus?.section;
    if (under) {
      s.active = under;
      return under;
    }
    if (s.active && !isClaimed(s.active)) return s.active;
    s.active = undefined;
    return undefined;
  }

  /**
   * A click landing anywhere in a section still owed puts the caret on that
   * section's typing position instead of where the click landed. Typing is
   * matched across the whole section, so without this the character would
   * appear somewhere other than the caret that asked for it — and the caret is
   * the one thing a reader trusts about where their typing goes.
   *
   * Landing in the part already typed snaps too. A click there is not a request
   * to write in the middle of covered text — nothing would accept it — it is
   * someone pointing at the section they want to work on, and the answer is to
   * be ready for them to type rather than to sit inert until they find the
   * exact offset for themselves.
   *
   * Only inside a section, and only while guidance is armed: a caret the
   * reviewer put somewhere to read, or put anywhere at all with editing on,
   * stays where they put it.
   */
  private snapToTypingPosition(): void {
    const focus = this.focus();
    if (!focus?.guided) return;
    const boundary = typedBoundary(focus.section);
    if (focus.cursor === boundary) return;
    this.moveCursorTo(boundary);
  }

  private editorsFor(document: vscode.TextDocument): vscode.TextEditor[] {
    return vscode.window.visibleTextEditors.filter((e) => e.document === document);
  }

  private moveCursorTo(
    offset: number,
    reveal = vscode.TextEditorRevealType.InCenterIfOutsideViewport
  ): void {
    const s = this.session;
    if (!s) return;
    const editor =
      vscode.window.activeTextEditor?.document === s.document
        ? vscode.window.activeTextEditor
        : this.editorsFor(s.document)[0];
    if (!editor) return;
    const at = s.document.positionAt(offset);
    editor.selection = new vscode.Selection(at, at);
    editor.revealRange(new vscode.Range(at, at), reveal);
  }

  // --- rendering --------------------------------------------------------------

  /** The run the next keystroke should produce: the pending whitespace run
   * when one is ahead (any whitespace key applies it), else one character. */
  private nextTargetRange(section: Section): vscode.Range | undefined {
    const s = this.session;
    if (!s || section.kind !== 'type') return undefined;
    const remaining = section.target.slice(section.position);
    if (remaining.length === 0) return undefined;
    const run = /^\s+/.exec(remaining);
    const from = typedBoundary(section);
    return new vscode.Range(
      s.document.positionAt(from),
      s.document.positionAt(from + (run ? run[0].length : 1))
    );
  }

  /**
   * Animate the run a gesture just covered, between two positions in the given
   * section. Typed characters strike one at a time; runs the reviewer did not
   * type are wiped, so a fill never masquerades as typing.
   */
  private animateRun(
    section: Section,
    from: number,
    to: number,
    how: 'strike' | 'wipe'
  ): void {
    const s = this.session;
    if (!s || to <= from) return;
    const range = new vscode.Range(
      s.document.positionAt(section.start + from),
      s.document.positionAt(section.start + to)
    );
    if (how === 'strike') this.fx.strike(range);
    else this.fx.wipe(range);
  }

  private flashMismatch(section: Section): void {
    const range = this.nextTargetRange(section);
    if (range) this.fx.reject(range);
  }

  /** The lens strip: controls on the active section, and a way in to every
   * section still owed — with no order to the walk, the sections the reviewer
   * hasn't reached have to be reachable from wherever they are. */
  private lensesFor(document: vscode.TextDocument): vscode.CodeLens[] {
    const s = this.session;
    if (!s || document !== s.document) return [];
    const active = s.active;
    const claimed = claimedCount(s.sections);
    const total = s.sections.length;

    const lensAt = (offset: number) => {
      const line = document.positionAt(offset).line;
      const range = new vscode.Range(line, 0, line, 0);
      return (
        title: string,
        command: string,
        tooltip?: string,
        args?: unknown[]
      ) => new vscode.CodeLens(range, { title, command, tooltip, arguments: args });
    };

    const lenses: vscode.CodeLens[] = [];
    for (const section of s.sections) {
      if (isClaimed(section)) continue;
      const lens = lensAt(section.start);
      // A lens renders above its line, which is where a removal's lines used
      // to be: the count reads as a fact about the gap it is sitting in rather
      // than about the code under it, which is the one thing the margin could
      // never manage.
      const replaces =
        section.removedLines.length > 0
          ? ` · replaces ${lineCount(section.removedLines.length)}`
          : '';
      if (section !== active) {
        lenses.push(
          lens(
            section.kind === 'confirm'
              ? `${deletedLines(section.removedLines.length)} here — review this`
              : `Not reviewed yet — start here${replaces}`,
            'copyworkcode.focusSection',
            'Put the cursor at this section and start typing it',
            [section.start]
          )
        );
        continue;
      }
      const where = `${claimed}/${total} claimed`;
      const diffLens = lens(
        'Show diff',
        'copyworkcode.showReviewDiff',
        `Open the diff against ${this.source.baselineLabel} side by side (Alt+D)`
      );
      const stopLens = lens(
        'Stop',
        'copyworkcode.abortReview',
        'Stop this review and discard its progress — your edits stay in the ' +
          'file and the debt stays (Shift+Esc)'
      );
      const editLens = s.editing
        ? lens(
            'Back to typing',
            'copyworkcode.resumeTyping',
            'Match the target again, from where this section left off (Ctrl+E)'
          )
        : lens(
            'Write here',
            'copyworkcode.enableEditing',
            'Edit the file yourself — guidance stands down until you come back (Ctrl+E)'
          );
      if (section.kind === 'confirm') {
        lenses.push(
          lens(`${deletedLines(section.removedLines.length)} here · ${where}`, ''),
          lens(
            'Confirm deletion',
            'copyworkcode.confirmSection',
            'Acknowledge the deleted lines and move to the next section (Alt+S)'
          ),
          editLens,
          diffLens,
          stopLens
        );
        continue;
      }
      lenses.push(
        lens(
          `Typed ${section.position}/${section.target.length} · ${where}${replaces}`,
          ''
        ),
        // First of the actions: disagreeing with the code is the point of a
        // review, and the fills are conveniences that don't need advertising.
        editLens,
        lens(
          'Skip section',
          'copyworkcode.skipSection',
          'Fill in this whole section and move on, recorded as skipped (Alt+S)'
        ),
        diffLens,
        stopLens
      );
    }

    if (total > 0 && claimed >= total) {
      const lens = lensAt(s.sections[0].start);
      lenses.push(
        lens(
          `All ${total} section(s) claimed — finish the review`,
          'copyworkcode.finishReview',
          'Save the file, record the review, and clear its debt (Alt+Enter)'
        )
      );
    }
    return lenses;
  }

  private updateUi(note?: string): void {
    const s = this.session;
    if (!s) return;
    const focus = this.focus();
    const active = this.activeSection(focus);
    this.paint(s, active, focus);

    const claimed = claimedCount(s.sections);
    const complete = claimed >= s.sections.length;
    void this.setContext('copyworkcode.reviewing', true);
    void this.setContext(
      'copyworkcode.reviewEditorFocused',
      vscode.window.activeTextEditor?.document === s.document
    );
    void this.setContext('copyworkcode.sectionActive', active !== undefined);
    void this.setContext('copyworkcode.guided', focus?.guided === true);
    void this.setContext('copyworkcode.editing', s.editing);
    void this.setContext('copyworkcode.reviewComplete', complete);

    this.statusBar.text = this.statusText(s, active, focus, note);
    // The one state where the review is not policing the file at all. It reads
    // as an ordinary editor from the inside, so the badge has to say so.
    this.statusBar.backgroundColor = s.editing
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
    this.statusBar.tooltip = `Reviewing ${path.basename(s.file)} against ${
      this.source.baselineLabel
    } — ${complete ? 'click to finish' : 'click to jump to the next section'}`;
    this.statusBar.command = complete
      ? 'copyworkcode.finishReview'
      : 'copyworkcode.jumpToReview';
    this.statusBar.show();

    // The lens strip is expensive to re-provide and the cursor moves
    // constantly, so it is only invalidated when what it shows has changed.
    const key = [
      claimed,
      s.sections.length,
      s.editing,
      active ? s.sections.indexOf(active) : -1,
      active?.position ?? -1,
      active?.target.length ?? -1,
      s.sections.map((x) => x.start).join(','),
    ].join('|');
    if (key !== this.lensKey) {
      this.lensKey = key;
      this.lensEmitter.fire();
    }
  }

  private paint(
    s: Session,
    active: Section | undefined,
    focus: Focus | undefined
  ): void {
    const editors = this.editorsFor(s.document);
    if (editors.length === 0) {
      this.paintKey = '';
      return;
    }
    // Cursor movement drives this, and a matched keystroke moves the cursor
    // itself, so an unguarded repaint would run several times per keystroke for
    // nothing. Everything the decorations are derived from is in this key.
    const key = [
      s.document.version,
      editors.length,
      s.editing,
      active ? s.sections.indexOf(active) : -1,
      focus?.guided ? focus.cursor : -1,
      s.sections
        .map((x) => `${x.start}.${x.end}.${x.position}.${x.outcome ?? ''}`)
        .join(';'),
    ].join('|');
    if (key === this.paintKey) return;
    this.paintKey = key;

    const range = (from: number, to: number) =>
      new vscode.Range(s.document.positionAt(from), s.document.positionAt(to));
    // A section's end sits at the start of the line after it, so a whole-line
    // decoration has to stop one character short of it.
    const lines = (section: Section) =>
      range(section.start, Math.max(section.start, section.end - 1));

    // Dim what is still owed: the untyped remainder of every section nobody has
    // claimed yet. A section the reviewer took over is theirs — it stops being
    // dimmed the moment guidance steps aside, and is marked instead.
    const owed: vscode.Range[] = [];
    const takenOver: vscode.Range[] = [];
    for (const section of s.sections) {
      if (section.kind !== 'type') continue;
      if (!isClaimed(section)) {
        if (section.position < section.target.length) {
          owed.push(range(typedBoundary(section), section.end));
        }
      } else if (section.outcome === 'edited' && section.end > section.start) {
        takenOver.push(lines(section));
      }
    }

    // A removal is the one change with no text of its own to carry a
    // decoration, so it gets a mark of its own — for as long as its section is
    // still owed, and not a moment after it is claimed.
    const removals = removalRanges(
      s.document,
      this.markedRemovals(s).map((section) => this.removalOf(s, section))
    );

    const highlight = active ? [lines(active)] : [];
    const target = focus?.guided ? this.nextTargetRange(focus.section) : undefined;

    for (const editor of editors) {
      editor.setDecorations(this.pending, owed);
      editor.setDecorations(this.takenOver, takenOver);
      editor.setDecorations(this.currentSection, s.editing ? [] : highlight);
      editor.setDecorations(this.editingSection, s.editing ? highlight : []);
      editor.setDecorations(this.nextTarget, target ? [target] : []);
      this.removals.apply(editor, removals);
    }
  }

  private statusText(
    s: Session,
    active: Section | undefined,
    focus: Focus | undefined,
    note?: string
  ): string {
    const claimed = claimedCount(s.sections);
    const total = s.sections.length;
    const flag = note ? `$(error) ${note} — ` : '';
    const stop = 'Shift+Esc stop';

    if (s.editing) {
      return (
        `${flag}$(unlock) Editing · Review ${claimed}/${total} claimed — ` +
        `Ctrl+E back to typing · ${stop}`
      );
    }
    if (claimed >= total) {
      return `${flag}$(check) Review ${claimed}/${total} claimed — Alt+Enter finish · ${stop}`;
    }
    if (!active) {
      const here = focus && enclosingSection(s.sections, focus.cursor);
      const where =
        here?.outcome === 'edited'
          ? '$(edit) Yours to write here · Review'
          : '$(keyboard) Review';
      return `${flag}${where} ${claimed}/${total} claimed — Alt+J next section · ${stop}`;
    }
    if (active.kind === 'confirm') {
      return (
        `${flag}$(diff-removed) Review ${claimed}/${total} · ${active.removedLines.length} line(s) deleted — ` +
        `Alt+S confirm · Alt+J jump · ${stop}`
      );
    }
    const at = focus?.guided
      ? `typed ${active.position}/${active.target.length}`
      : 'Alt+J to the typing position';
    return (
      `${flag}$(keyboard) Review ${claimed}/${total} · ${at} — ` +
      `Alt+F line · Alt+S skip · Ctrl+E write · ${stop}`
    );
  }

  private async setContext(key: string, value: boolean): Promise<void> {
    if (this.contexts.get(key) === value) return;
    this.contexts.set(key, value);
    await vscode.commands.executeCommand('setContext', key, value);
  }

  dispose(): void {
    this.parked.clear();
    this.changeGuard.dispose();
    this.closeGuard.dispose();
    this.focusGuard.dispose();
    this.selectionGuard.dispose();
    this.visibilityGuard.dispose();
    this.typeOverride?.dispose();
    this.fx.dispose();
    this.pending.dispose();
    this.currentSection.dispose();
    this.takenOver.dispose();
    this.editingSection.dispose();
    this.nextTarget.dispose();
    this.removals.dispose();
    this.lensProvider.dispose();
    this.hoverProvider.dispose();
    this.lensEmitter.dispose();
    this.statusBar.dispose();
    this.emitter.dispose();
    this.startEmitter.dispose();
  }
}

/** Whether a review opens with editing enabled instead of guidance armed. */
function startEditing(): boolean {
  return vscode.workspace
    .getConfiguration('copyworkcode')
    .get<boolean>('startEditing', false);
}

/** How a `type` section that just closed is recorded. Text the reviewer wrote
 * themselves outranks the rest: what matters afterwards is that the file no
 * longer says only what the agent wrote. */
function outcomeOf(section: Section): SectionOutcome {
  if (section.handEdited) return 'edited';
  return section.touched ? 'typed' : 'skipped';
}

/** Note which sections the reviewer's own writing landed in, so one they took
 * over reads as edited rather than typed when it closes. Only while editing is
 * enabled: every other change is a formatter, an agent, or the review itself,
 * and none of those is the reviewer taking the code over. */
function markHandEdited(
  sections: readonly Section[],
  changes: readonly TextChange[]
): void {
  for (const change of changes) {
    for (const section of sections) {
      if (isClaimed(section) || section.kind !== 'type') continue;
      if (change.from <= section.end && change.to >= section.start) {
        section.handEdited = true;
      }
    }
  }
}
