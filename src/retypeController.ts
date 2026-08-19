import * as path from 'path';
import * as vscode from 'vscode';
import { diffLines } from './core/diff';
import { RetypeEngine } from './core/retype';
import { advanceBaseline } from './core/baselineStore';
import { DebtSource } from './debtSource';
import { ReviewLog } from './reviewState';
import { TypingFx } from './typingFx';

export const BASELINE_SCHEME = 'copyworkcode-baseline';

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

interface HunkTask {
  /** A `type` task is retyped; a `confirm` task marks lines that were only
   * deleted — nothing to retype, acknowledged with one action. */
  kind: 'type' | 'confirm';
  /** Offsets of the hunk in the document. Stable for the whole review: the
   * buffer is never edited by the flow, and any foreign edit aborts it. For
   * `confirm` tasks this is a zero-width anchor at the deletion point. */
  startOffset: number;
  endOffset: number;
  /** Exact document text of the range — the retype target. '' for confirm. */
  target: string;
  /** How many baseline lines disappeared at this hunk (context for the UI). */
  removedLines: number;
}

interface Session {
  root: string;
  file: string;
  document: vscode.TextDocument;
  tasks: HunkTask[];
  index: number;
  engine: RetypeEngine;
  hunksTyped: number;
  hunksSkipped: number;
  hunksConfirmed: number;
  /** True once any keystroke was accepted in the current hunk. */
  currentHunkTyped: boolean;
}

/**
 * Where a review was parked when the reviewer moved to another file. Kept in
 * memory only, and only valid while the file's content is byte-identical to
 * what it was at pause time — the section offsets are computed from it.
 */
interface ParkedReview {
  index: number;
  position: number;
  /** Section count at pause time; a different one means a different walk. */
  total: number;
  content: string;
  hunksTyped: number;
  hunksSkipped: number;
  hunksConfirmed: number;
  currentHunkTyped: boolean;
}

/** What the debt view shows about a file that is under review or parked. */
export interface ReviewProgress {
  index: number;
  total: number;
  /** True for the live review, false for a parked one. */
  active: boolean;
}

/**
 * Drives the guided retype for one file. The review opens the file in a
 * normal editor — not a diff — so the review flow owns all the visuals:
 * untyped text is dimmed, the active section carries a highlight and a lens
 * strip with its controls, and the exact next character to type is marked.
 * The baseline diff stays one action away instead of being the surface.
 *
 * The buffer already holds the final content and is never modified — each
 * accepted keystroke advances a matching engine, and the dimmed rendering
 * recedes as the engine moves. Typing is intercepted with a `type` command
 * override, so keystrokes are validated without inserting anything, and
 * completions, snippets and auto-closing pairs never act on the user's
 * behalf inside the review. The editor is additionally marked read-only for
 * the session, so editing gestures that bypass the override (paste, undo,
 * line moves…) are inert instead of editing the buffer behind the engine's
 * back; Enter and Tab, which are dispatched as editor commands rather than
 * `type` input, are rebound to route through the engine.
 *
 * Because the flow never edits the buffer, there is nothing to restore:
 * stopping a review (explicitly, by closing the review editor, or because the
 * file changed underneath) just drops the overlay and leaves the debt.
 *
 * One review is live at a time, but reviews are not one-shot: starting a
 * second file parks the first one's position and counters, and coming back
 * resumes it where it stood as long as the file is unchanged.
 */
export class RetypeController implements vscode.Disposable {
  private session?: Session;
  /** Positions of reviews parked by moving to another file, keyed by path. */
  private parked = new Map<string, ParkedReview>();
  /** Guards the async span of start() before `session` exists, so a doubled
   * command invocation (double-click, impatient re-click) can't interleave
   * two setups over the same state. */
  private starting = false;
  private typeOverride?: vscode.Disposable;
  /** Files still flagged session-read-only after their review ended with no
   * editor to run the reset on; cleared when they next become active. */
  private pendingReadonlyReset = new Set<string>();
  private emitter = new vscode.EventEmitter<void>();
  /** Fires when a review finishes, aborts, or is otherwise torn down. */
  readonly onDidFinish = this.emitter.event;

  /** Untyped text: kept in the buffer, rendered dimmed until typed over. */
  private pending = vscode.window.createTextEditorDecorationType({
    opacity: '0.35',
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
  /** The exact text the next keystroke should produce. */
  private nextTarget = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.findMatchBackground'),
  });
  /** Animation for accepted keystrokes, fills, and mismatches. Decoration
   * only: it trails the engine and never affects what a keystroke does. */
  private fx = new TypingFx();

  private statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  private lensEmitter = new vscode.EventEmitter<void>();
  private lensProvider: vscode.Disposable;
  private changeGuard: vscode.Disposable;
  private focusGuard: vscode.Disposable;
  private tabGuard: vscode.Disposable;

  constructor(
    private log: ReviewLog,
    private source: DebtSource
  ) {
    // The flow itself never edits the document, so any content change during
    // a review is foreign (a formatter, an agent, a reload from disk). The
    // hunk offsets are invalid from that point on: drop the review, keep the
    // new content — it was never touched — and leave the debt in place.
    this.changeGuard = vscode.workspace.onDidChangeTextDocument((e) => {
      const s = this.session;
      if (s && e.document === s.document && e.contentChanges.length > 0) {
        void this.abort(
          'CopyWorkCode: review stopped — the file changed outside the retype flow. Debt unchanged.'
        );
      }
    });
    this.focusGuard = vscode.window.onDidChangeActiveTextEditor((editor) => {
      this.updateFocusContext();
      if (
        editor &&
        this.pendingReadonlyReset.delete(editor.document.uri.toString())
      ) {
        void vscode.commands.executeCommand(RESET_READONLY);
      }
    });
    // Closing the review editor ends the live review — without this, the
    // session would silently outlive its editor. Closing a tab is rarely a
    // decision to abandon the typing done so far, so the position is parked
    // rather than dropped: reopening the file picks it up again.
    this.tabGuard = vscode.window.tabGroups.onDidChangeTabs(() => {
      const s = this.session;
      if (s && !this.reviewTabOpen(s.document)) {
        void this.park(
          `CopyWorkCode: review of ${path.basename(s.file)} parked — reopen the file to resume.`
        );
      }
    });
    this.lensProvider = vscode.languages.registerCodeLensProvider(
      { scheme: 'file' },
      {
        onDidChangeCodeLenses: this.lensEmitter.event,
        provideCodeLenses: (document) => this.lensesFor(document),
      }
    );
    this.statusBar.command = 'copyworkcode.jumpToReview';
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
    // The gate covers parking too — parking awaits, and a second click during
    // that window would otherwise start its own setup alongside this one.
    this.starting = true;
    try {
      if (this.session) {
        await this.park();
      }
      await this.startLocked(root, file);
    } finally {
      this.starting = false;
    }
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
    const tasks: HunkTask[] = diffLines(baseline, current).map((h) => {
      const startOffset = document.offsetAt(new vscode.Position(h.currentStart, 0));
      if (h.addedLines.length === 0) {
        return {
          kind: 'confirm' as const,
          startOffset,
          endOffset: startOffset,
          target: '',
          removedLines: h.removedLines.length,
        };
      }
      const endOffset = document.offsetAt(
        new vscode.Position(h.currentStart + h.addedLines.length, 0)
      );
      return {
        kind: 'type' as const,
        startOffset,
        endOffset,
        target: current.slice(startOffset, endOffset),
        removedLines: h.removedLines.length,
      };
    });

    await vscode.window.showTextDocument(document, { preview: false });

    if (tasks.length === 0) {
      // Line-ending or whitespace-normalization drift only: nothing to walk.
      // No session exists to protect, and the notification can stay pending
      // indefinitely — release the start gate before awaiting it.
      this.starting = false;
      this.parked.delete(file);
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

    const resume = this.resumeState(file, current, tasks.length);
    this.session = {
      root,
      file,
      document,
      tasks,
      index: resume?.index ?? 0,
      engine: new RetypeEngine(tasks[resume?.index ?? 0].target),
      hunksTyped: resume?.hunksTyped ?? 0,
      hunksSkipped: resume?.hunksSkipped ?? 0,
      hunksConfirmed: resume?.hunksConfirmed ?? 0,
      currentHunkTyped: false,
    };

    try {
      this.typeOverride = vscode.commands.registerCommand('type', (args) =>
        this.onType(args)
      );
    } catch {
      // Another extension owns `type` (e.g. a modal-editing plugin): retype
      // can't validate keystrokes, so don't pretend to review.
      this.session = undefined;
      void vscode.window.showErrorMessage(
        'CopyWorkCode: another extension intercepts typing; guided retype is unavailable.'
      );
      return;
    }

    // The type override covers printable input; every other editing gesture
    // (enter, paste, drag-and-drop, line moves, undo…) would edit the buffer
    // behind the engine's back and end the review as a foreign change.
    // Marking the review editor read-only for the session makes them all
    // inert at once — keyboard typing still reaches the override, because
    // the editor dispatches the `type` command before its read-only check.
    await vscode.commands.executeCommand(SET_READONLY);

    await vscode.commands.executeCommand('setContext', 'copyworkcode.reviewing', true);
    this.updateFocusContext();
    this.fx.bind(document);
    this.beginHunk(resume?.position ?? 0, resume?.currentHunkTyped ?? false);
    if (resume) {
      void vscode.window.setStatusBarMessage(
        `CopyWorkCode: resumed at section ${resume.index + 1}/${tasks.length}.`,
        6000
      );
    }
  }

  /**
   * The parked position for this file, if it still applies. A parked review
   * describes offsets in the content it was parked on, so anything that
   * changed the file (an agent edit, a formatter, a switched baseline mode)
   * invalidates it and the walk starts over.
   */
  private resumeState(
    file: string,
    current: string,
    total: number
  ): ParkedReview | undefined {
    const parked = this.parked.get(file);
    this.parked.delete(file);
    if (!parked) return undefined;
    if (parked.content === current && parked.total === total && parked.index < total) {
      return parked;
    }
    void vscode.window.setStatusBarMessage(
      'CopyWorkCode: the file changed while parked — restarting this review.',
      6000
    );
    return undefined;
  }

  private beginHunk(position = 0, typed = false): void {
    const s = this.session;
    if (!s) return;
    s.engine = new RetypeEngine(s.tasks[s.index].target, position);
    s.currentHunkTyped = typed;
    this.moveCursor();
    this.updateUi();
  }

  private async onType(args: { text: string }): Promise<void> {
    const s = this.session;
    const editor = vscode.window.activeTextEditor;
    if (!s || !editor || editor.document !== s.document) {
      await vscode.commands.executeCommand('default:type', args);
      return;
    }
    const task = s.tasks[s.index];
    if (task.kind === 'confirm') {
      this.updateUi('nothing to type — Alt+S confirms the deletion');
      return;
    }
    const from = s.engine.position;
    const result = s.engine.handleInput(args.text ?? '');
    if (result.kind === 'reject') {
      this.flashMismatch();
      this.updateUi('wrong key');
      return;
    }
    s.currentHunkTyped = true;
    this.animateRun(task, from, s.engine.position, 'strike');
    await this.advance();
  }

  /** Tab is a separate editor command, not `type` input — route it through
   * the engine as whitespace so it snaps indentation like space/enter do. */
  async typeTab(): Promise<void> {
    await this.onType({ text: '\t' });
  }

  /** Enter never reaches the `type` override either — unrebound it would
   * try a real line break, which the session read-only flag turns into a
   * "read-only editor" notice instead of an accepted keystroke. */
  async typeEnter(): Promise<void> {
    await this.onType({ text: '\n' });
  }

  /** The engine position moved: sync cursor and overlay, close out the hunk
   * (and possibly the review) when the target is fully covered. */
  private async advance(): Promise<void> {
    const s = this.session;
    if (!s) return;
    this.moveCursor();
    this.updateUi();
    if (!s.engine.done) return;
    await this.completeTask(s.currentHunkTyped ? 'typed' : 'skipped');
  }

  private async completeTask(
    how: 'typed' | 'skipped' | 'confirmed'
  ): Promise<void> {
    const s = this.session;
    if (!s) return;
    if (how === 'typed') s.hunksTyped++;
    else if (how === 'skipped') s.hunksSkipped++;
    else s.hunksConfirmed++;
    s.index++;
    if (s.index < s.tasks.length) {
      this.beginHunk();
    } else {
      await this.finish();
    }
  }

  async skipSection(): Promise<void> {
    const s = this.session;
    if (!s) return;
    const task = s.tasks[s.index];
    if (task.kind === 'confirm') {
      await this.completeTask('confirmed');
      return;
    }
    const from = s.engine.position;
    s.engine.fillRest();
    s.currentHunkTyped = false;
    this.animateRun(task, from, s.engine.position, 'wipe');
    await this.advance();
  }

  /** Acknowledge a deletion-only section (the lens button's command). */
  async confirmSection(): Promise<void> {
    const s = this.session;
    if (!s || s.tasks[s.index].kind !== 'confirm') return;
    await this.completeTask('confirmed');
  }

  async fillNextLine(): Promise<void> {
    const s = this.session;
    if (!s) return;
    const task = s.tasks[s.index];
    if (task.kind === 'confirm') {
      await this.completeTask('confirmed');
      return;
    }
    const from = s.engine.position;
    s.engine.fillLine();
    this.animateRun(task, from, s.engine.position, 'wipe');
    await this.advance();
  }

  /**
   * Right-arrow behavior inside a review: fill the next word instead of
   * moving. The cursor cannot usefully go right anyway — everything to the
   * right is text still owed — so the key spends itself on the word ahead.
   * Away from the typing position (cursor parked elsewhere while reading, a
   * selection open, or a deletion-only section) it moves as it normally
   * would, so no fill ever happens where the reviewer isn't looking.
   */
  async fillNextWord(): Promise<void> {
    const s = this.session;
    const editor = vscode.window.activeTextEditor;
    const at = this.cursorPosition();
    if (
      !s ||
      !at ||
      !editor ||
      editor.document !== s.document ||
      !editor.selection.isEmpty ||
      !editor.selection.active.isEqual(at) ||
      s.tasks[s.index].kind !== 'type'
    ) {
      await vscode.commands.executeCommand('cursorRight');
      return;
    }
    const task = s.tasks[s.index];
    const from = s.engine.position;
    s.engine.fillWord();
    this.animateRun(task, from, s.engine.position, 'wipe');
    await this.advance();
  }

  /** Bring the viewport and cursor back to the next thing to review. */
  async jumpToCurrent(): Promise<void> {
    const s = this.session;
    if (!s) return;
    await vscode.window.showTextDocument(s.document, { preview: false });
    this.moveCursor(vscode.TextEditorRevealType.InCenter);
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

  /** Position of the live or parked review of a file, for the debt view. */
  progressFor(file: string): ReviewProgress | undefined {
    const s = this.session;
    if (s && s.file === file) {
      return { index: s.index, total: s.tasks.length, active: true };
    }
    const parked = this.parked.get(file);
    return parked
      ? { index: parked.index, total: parked.total, active: false }
      : undefined;
  }

  /**
   * Drop whatever review state a file has because its debt was cleared some
   * other way — marked reviewed from the view, or auto-skipped. Without this,
   * a stale parked position would outlive the debt it belonged to.
   */
  async forget(file: string): Promise<void> {
    this.parked.delete(file);
    if (this.session?.file === file) {
      await this.abort(
        `CopyWorkCode: review of ${path.basename(file)} stopped — it was marked reviewed without typing.`
      );
    }
  }

  /**
   * Set the live review aside with its position intact and no session left to
   * block the next one. Nothing is written and nothing is logged: parking is
   * not an outcome, it is the same review waiting to be picked up.
   */
  private async park(message?: string): Promise<void> {
    const s = this.session;
    if (!s) return;
    this.session = undefined;
    this.parked.set(s.file, {
      index: s.index,
      position: s.engine.position,
      total: s.tasks.length,
      content: s.document.getText(),
      hunksTyped: s.hunksTyped,
      hunksSkipped: s.hunksSkipped,
      hunksConfirmed: s.hunksConfirmed,
      currentHunkTyped: s.currentHunkTyped,
    });
    await this.clearReadonly(s.document);
    await this.teardown();
    void vscode.window.setStatusBarMessage(
      message ??
        `CopyWorkCode: ${path.basename(s.file)} parked at section ${s.index + 1}/${s.tasks.length}.`,
      6000
    );
  }

  async abort(message?: string): Promise<void> {
    const s = this.session;
    if (!s) return;
    this.session = undefined;
    // Stopping is deliberate, unlike parking: the next review of this file
    // starts from the first section again.
    this.parked.delete(s.file);
    await this.clearReadonly(s.document);
    await this.teardown();
    void vscode.window.showInformationMessage(
      message ?? 'CopyWorkCode: review stopped. The file is untouched; debt unchanged.'
    );
  }

  private async finish(): Promise<void> {
    const s = this.session;
    if (!s) return;
    this.session = undefined;
    this.parked.delete(s.file);
    // The flow made no edits, but the document may carry the user's own
    // unsaved changes from before the review; the baseline must match what
    // is on disk or the debt view would report phantom debt. Read-only must
    // lift first — a session-read-only editor may refuse the save.
    await this.clearReadonly(s.document);
    await s.document.save();
    advanceBaseline(s.root, s.file, s.document.getText());
    this.log.add({
      file: s.file,
      at: new Date().toISOString(),
      outcome: s.hunksTyped + s.hunksConfirmed > 0 ? 'typed' : 'skipped',
      hunksTyped: s.hunksTyped,
      hunksSkipped: s.hunksSkipped,
      hunksConfirmed: s.hunksConfirmed,
    });
    await this.teardown();
    const parts = [
      `${s.hunksTyped} section(s) typed`,
      `${s.hunksSkipped} skipped`,
    ];
    if (s.hunksConfirmed > 0) {
      parts.push(`${s.hunksConfirmed} deletion(s) confirmed`);
    }
    void vscode.window.showInformationMessage(
      `CopyWorkCode: review complete — ${parts.join(', ')}.`
    );
  }

  private async teardown(): Promise<void> {
    this.typeOverride?.dispose();
    this.typeOverride = undefined;
    this.statusBar.hide();
    this.fx.clear();
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.pending, []);
      editor.setDecorations(this.currentSection, []);
      editor.setDecorations(this.nextTarget, []);
    }
    await vscode.commands.executeCommand('setContext', 'copyworkcode.reviewing', false);
    this.updateFocusContext();
    this.lensEmitter.fire();
    this.emitter.fire();
  }

  /** Lift the session read-only flag set at review start. The workbench
   * command targets the active editor only, so the reset can run right away
   * only while the reviewed file really is the active editor. During a
   * tab-close teardown `activeTextEditor` still points at the closed editor
   * (it lags the tab list that fired the teardown), and the command would
   * land on whichever tab the workbench moved on to — hence the extra tab
   * check. Every other case defers the reset until the file next becomes
   * active. */
  private async clearReadonly(document: vscode.TextDocument): Promise<void> {
    if (
      vscode.window.activeTextEditor?.document === document &&
      this.reviewTabOpen(document)
    ) {
      await vscode.commands.executeCommand(RESET_READONLY);
    } else {
      this.pendingReadonlyReset.add(document.uri.toString());
    }
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

  /** Keeps the `copyworkcode.reviewEditorFocused` context in sync: true only
   * while a review is active and its document is the active editor, so the
   * key rebinds above never affect other editors. */
  private updateFocusContext(): void {
    const focused =
      this.session !== undefined &&
      vscode.window.activeTextEditor?.document === this.session.document;
    void vscode.commands.executeCommand(
      'setContext',
      'copyworkcode.reviewEditorFocused',
      focused
    );
  }

  private editorFor(document: vscode.TextDocument): vscode.TextEditor | undefined {
    return vscode.window.visibleTextEditors.find((e) => e.document === document);
  }

  private cursorPosition(): vscode.Position | undefined {
    const s = this.session;
    if (!s || s.index >= s.tasks.length) return undefined;
    const task = s.tasks[s.index];
    return s.document.positionAt(task.startOffset + s.engine.position);
  }

  private moveCursor(
    reveal = vscode.TextEditorRevealType.InCenterIfOutsideViewport
  ): void {
    const s = this.session;
    const at = this.cursorPosition();
    if (!s || !at) return;
    const editor = this.editorFor(s.document);
    if (!editor) return;
    editor.selection = new vscode.Selection(at, at);
    editor.revealRange(new vscode.Range(at, at), reveal);
  }

  /** The run the next keystroke should produce: the pending whitespace run
   * when one is ahead (any whitespace key applies it), else one character. */
  private nextTargetRange(s: Session): vscode.Range | undefined {
    const task = s.tasks[s.index];
    if (task.kind !== 'type' || s.engine.done) return undefined;
    const run = /^\s+/.exec(s.engine.remaining);
    const length = run ? run[0].length : 1;
    const from = task.startOffset + s.engine.position;
    return new vscode.Range(
      s.document.positionAt(from),
      s.document.positionAt(from + length)
    );
  }

  /**
   * Animate the run a gesture just covered, between two engine positions in
   * the given task. Typed characters strike one at a time; runs the reviewer
   * did not type are wiped, so a fill never masquerades as typing.
   */
  private animateRun(
    task: HunkTask,
    from: number,
    to: number,
    how: 'strike' | 'wipe'
  ): void {
    const s = this.session;
    if (!s || to <= from) return;
    const range = new vscode.Range(
      s.document.positionAt(task.startOffset + from),
      s.document.positionAt(task.startOffset + to)
    );
    if (how === 'strike') this.fx.strike(range);
    else this.fx.wipe(range);
  }

  private flashMismatch(): void {
    const s = this.session;
    if (!s) return;
    const range = this.nextTargetRange(s);
    if (range) this.fx.reject(range);
  }

  /** The lens strip above the active section: position + controls. */
  private lensesFor(document: vscode.TextDocument): vscode.CodeLens[] {
    const s = this.session;
    if (!s || document !== s.document || s.index >= s.tasks.length) return [];
    const task = s.tasks[s.index];
    const line = document.positionAt(task.startOffset).line;
    const range = new vscode.Range(line, 0, line, 0);
    const lens = (title: string, command: string, tooltip?: string) =>
      new vscode.CodeLens(range, { title, command, tooltip });
    const where = `Section ${s.index + 1}/${s.tasks.length}`;
    // Each control names what it does and ends with its key, so the strip
    // stays narrow and the shortcut is one hover away.
    const diffLens = lens(
      'Show diff',
      'copyworkcode.showReviewDiff',
      `Open the diff against ${this.source.baselineLabel} side by side (Alt+D)`
    );
    const stopLens = lens(
      'Stop',
      'copyworkcode.abortReview',
      'Stop this review — the file is untouched and the debt stays (Shift+Esc)'
    );
    if (task.kind === 'confirm') {
      return [
        lens(`${where} — ${task.removedLines} line(s) deleted here`, ''),
        lens(
          'Confirm deletion',
          'copyworkcode.confirmSection',
          'Acknowledge the deleted lines and move to the next section (Alt+S)'
        ),
        diffLens,
        stopLens,
      ];
    }
    const replaces =
      task.removedLines > 0 ? ` · replaces ${task.removedLines} line(s)` : '';
    return [
      lens(
        `${where} — typed ${s.engine.position}/${task.target.length}${replaces}`,
        ''
      ),
      lens(
        'Fill word',
        'copyworkcode.fillNextWord',
        'Fill in the next word without typing it (Right arrow)'
      ),
      lens(
        'Fill line',
        'copyworkcode.fillNextLine',
        'Fill in the rest of this line without typing it (Alt+F)'
      ),
      lens(
        'Skip section',
        'copyworkcode.skipSection',
        'Fill in this whole section and move on, recorded as skipped (Alt+S)'
      ),
      diffLens,
      stopLens,
    ];
  }

  private updateUi(note?: string): void {
    const s = this.session;
    if (!s || s.index >= s.tasks.length) return;
    const task = s.tasks[s.index];

    const editor = this.editorFor(s.document);
    if (editor) {
      // Dim everything not yet typed: the rest of the current section plus
      // every type section still ahead.
      const pending: vscode.Range[] = [];
      if (task.kind === 'type') {
        pending.push(
          new vscode.Range(
            s.document.positionAt(task.startOffset + s.engine.position),
            s.document.positionAt(task.endOffset)
          )
        );
      }
      for (const t of s.tasks.slice(s.index + 1)) {
        if (t.kind === 'type') {
          pending.push(
            new vscode.Range(
              s.document.positionAt(t.startOffset),
              s.document.positionAt(t.endOffset)
            )
          );
        }
      }
      editor.setDecorations(this.pending, pending);

      // Whole-line highlight on the active section. endOffset sits at the
      // start of the line after the section, so step one character back to
      // keep that next line out of the whole-line range.
      const sectionEnd = s.document.positionAt(
        Math.max(task.startOffset, task.endOffset - 1)
      );
      editor.setDecorations(this.currentSection, [
        new vscode.Range(s.document.positionAt(task.startOffset), sectionEnd),
      ]);

      const target = this.nextTargetRange(s);
      editor.setDecorations(this.nextTarget, target ? [target] : []);
    }

    const flag = note ? `$(error) ${note} — ` : '';
    this.statusBar.text =
      task.kind === 'confirm'
        ? `${flag}$(diff-removed) Review ${s.index + 1}/${s.tasks.length}: deleted lines — ` +
          'Alt+S confirm · Alt+J jump · Shift+Esc stop'
        : `${flag}$(keyboard) Retype ${s.index + 1}/${s.tasks.length}: ` +
          '$(arrow-right) word · Alt+F line · Alt+S skip · Alt+J jump · Shift+Esc stop';
    this.statusBar.tooltip = `Reviewing ${path.basename(s.file)} against ${this.source.baselineLabel} — click to jump back to the typing position`;
    this.statusBar.show();
    this.lensEmitter.fire();
  }

  dispose(): void {
    this.changeGuard.dispose();
    this.focusGuard.dispose();
    this.tabGuard.dispose();
    this.typeOverride?.dispose();
    this.fx.dispose();
    this.pending.dispose();
    this.currentSection.dispose();
    this.nextTarget.dispose();
    this.lensProvider.dispose();
    this.lensEmitter.dispose();
    this.statusBar.dispose();
    this.emitter.dispose();
  }
}
