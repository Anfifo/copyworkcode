import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { advanceBaseline } from './core/baselineStore';
import { ViewSection, buildFileView } from './core/changeSet';
import {
  ChangeSetReview,
  FinishedFile,
  Outbound,
  RegionGesture,
  ReviewFile,
} from './core/changeSetReview';
import { DebtSource } from './debtSource';
import { ReviewLog } from './reviewState';

/**
 * The whole change set as one page: every file with review debt, every changed
 * region in it, read top to bottom and retyped in place without opening a
 * single editor.
 *
 * This is a second review surface, not a preview of the first one. Typing here
 * counts for exactly what typing in an editor counts for — the same outcomes
 * per region, the same record in the review log, the same baseline advance —
 * and the editor review stays the answer for reading a change with the language
 * server, the definitions and the neighbouring code around it. The page answers
 * the other question: what did the agent do, everywhere, in one sitting.
 *
 * It can be a page at all because typing writes nothing. A matched keystroke in
 * the editor review inserts no text — the buffer already holds the final
 * content and the review only advances a position through it — so a surface
 * that is not a buffer loses nothing by not being one. There is no
 * `WorkspaceEdit` here, no save, and no document to keep in step.
 *
 * What this class does is everything about the page that needs the editor: the
 * webview itself, reading the files the document is built from, moving baselines
 * and writing the review log. The rules — what a gesture comes to, which file
 * the page has taken over, when a region is claimed and a file finished — live
 * in `core/changeSetReview.ts`, where they can be tested without booting an
 * extension host.
 *
 * The page holds no file content the queue would not already have handed over:
 * the file list comes from `DebtSource.rows()`, which is where credential files
 * are refused, so nothing whose content must not be copied can reach the
 * payload in the first place.
 *
 * Region identity is shared with the editor review, not re-derived:
 * `buildFileView` lays out `buildSections`, so the page's *n*th region of a
 * file is the editor's *n*th region of it, and progress in one surface is
 * meaningful to the other.
 *
 * One surface owns a file at a time. Both would otherwise finish it, and a file
 * cannot be reviewed twice: the second finish writes a second record and
 * advances a baseline that already moved. Whichever surface the reviewer asked
 * for last wins — the first gesture that lands on a file here ends an editor
 * review of it, and starting an editor review of a file drops the progress this
 * page had on it — and only the colliding file is affected, never the rest of
 * the page.
 *
 * Progress lives here rather than in the webview, so the page can be hidden and
 * shown without losing it. Closing the page is a different thing: the state
 * goes with it, because unclaimed progress with no surface showing it is
 * progress nobody can see, reach, or finish.
 */

/** A gesture from the page. Ids are checked before anything is acted on. */
type Incoming =
  | { type: 'ready' }
  | { type: 'reload' }
  | RegionGesture
  | { type: 'expandGap'; file: string; from: number; to: number }
  | { type: 'openInEditor'; file: string; line: number };

export class ChangeSetPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private review = new ChangeSetReview();
  private emitter = new vscode.EventEmitter<void>();
  /** Fires when a file's review completed here, so the queue can be re-read. */
  readonly onDidFinish = this.emitter.event;
  /** Gestures run one at a time: each can end with file I/O and an await, and
   * two keystrokes overtaking each other would claim a region twice. */
  private gestures: Promise<unknown> = Promise.resolve();

  constructor(
    private extensionUri: vscode.Uri,
    private root: string,
    private source: DebtSource,
    private log: ReviewLog,
    /** Ends an editor review of a file the page is taking over. */
    private release: (file: string) => Promise<void>
  ) {}

  /** Open the page, or bring it forward if it is already open. */
  show(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'copyworkcode.changeSet',
      'AI Changes to Review',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
        // The page is a document the reviewer reads through, and where they
        // stopped reading is not something the extension can restore for them.
        retainContextWhenHidden: true,
      }
    );
    this.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.svg');
    panel.webview.html = this.html(panel.webview);
    panel.webview.onDidReceiveMessage((message) => this.receive(message));
    panel.onDidDispose(() => {
      this.panel = undefined;
      this.review.clear();
    });
  }

  /**
   * Another surface took this file over. The regions come back owed rather than
   * disappearing, because the file is still part of the change set and still has
   * to be read — it is only being reviewed somewhere else now.
   */
  dropFile(file: string): void {
    const dropped = this.review.dropFile(file);
    if (!dropped) return;
    this.post(dropped);
    void vscode.window.setStatusBarMessage(
      `CopyWorkCode: ${path.basename(file)} is being reviewed in the editor — the change set page gave up its progress on it.`,
      6000
    );
  }

  // --- payload ----------------------------------------------------------------

  /**
   * Rebuild the document from the queue as it stands. An explicit gesture, not
   * a reaction to the queue changing: the page is a sitting's worth of reading,
   * and rebuilding it under the reviewer would move the text they were part way
   * through typing.
   */
  private build(): void {
    const files: ReviewFile[] = [];
    for (const row of this.source.rows()) {
      const baseline = this.source.baselineFor(row.file);
      if (baseline === undefined) continue; // nothing to compare against
      const current = readFile(row.file);
      const view = buildFileView(row.file, relative(this.root, row.file), baseline, current);
      // No regions means line-ending drift only — nothing on the page to read.
      if (view.blocks.length === 0) continue;
      const sections: ViewSection[] = [];
      for (const block of view.blocks) {
        if (block.kind === 'section') sections.push(block.section);
      }
      files.push({
        view,
        current,
        sections,
        states: sections.map(() => ({ position: 0, touched: false })),
      });
    }
    this.review.load(files);
  }

  // --- gestures ---------------------------------------------------------------

  private receive(message: Incoming): void {
    if (!message || typeof message.type !== 'string') return;
    switch (message.type) {
      case 'ready':
        // A webview can be reloaded out from under a review (the command that
        // reloads them, an extension-host restart). Progress lives on this
        // side precisely so that is survivable, so a page asking for its
        // content gets what is already there — rebuilding is a gesture of its
        // own, below. Queued with the rest, so a rebuild can never land in the
        // middle of a keystroke and leave it writing to a document that is no
        // longer on screen.
        this.serialize(async () => {
          if (this.review.size === 0) this.build();
          this.sendSet();
        });
        return;
      case 'reload':
        this.serialize(async () => {
          this.build();
          this.sendSet();
        });
        return;
      case 'expandGap': {
        // Hand over the lines a gap is holding back.
        const lines = this.review.gap(message.file, message.from, message.to);
        if (lines) this.post(lines);
        return;
      }
      case 'openInEditor':
        void this.openInEditor(message.file, message.line);
        return;
      default:
        this.serialize(() => this.gesture(message));
    }
  }

  private serialize(work: () => Promise<void>): void {
    this.gestures = this.gestures.then(work, work).catch(() => undefined);
  }

  /**
   * Every gesture that moves a region's position or closes it out. What it comes
   * to is worked out before the page takes the file over, because a key this
   * region does not owe is not a review gesture, and it must not be the thing
   * that ends a review running in an editor.
   */
  private async gesture(message: RegionGesture): Promise<void> {
    const resolution = this.review.resolve(message);
    if (resolution.kind === 'ignore') return;
    if (resolution.kind === 'reject') {
      this.send(resolution.posts);
      return;
    }
    if (resolution.takesOver) {
      // Called on the first gesture that lands rather than when the page opens:
      // opening it is reading, and reading a change set should not end a review
      // the reviewer left running in an editor.
      this.review.takeOver(message.file);
      await this.release(message.file);
    }
    // An editor review can have started while that was awaiting, which replaces
    // this file's states: the gesture was aimed at progress the page no longer
    // holds, and `commit` says so by declining it.
    const commit = this.review.commit(resolution);
    if (!commit) return;
    this.send(commit.posts);
    if (commit.finished) this.finish(commit.finished);
  }

  /**
   * Every region of this file is accounted for. The baseline advances to the
   * content the page reviewed — not to whatever is on disk now, which may have
   * moved since the page opened. Advancing to what was actually read is what
   * keeps the difference between the two from being quietly signed off: it
   * comes back as debt on the next pass, which is the truth.
   */
  private finish(finished: FinishedFile): void {
    advanceBaseline(this.root, finished.file, finished.content);
    this.log.add({
      file: finished.file,
      at: new Date().toISOString(),
      outcome: finished.outcome,
      hunksTyped: finished.counts.typed,
      hunksSkipped: finished.counts.skipped,
      hunksConfirmed: finished.counts.confirmed,
      hunksEdited: finished.counts.edited,
    });
    this.emitter.fire();
  }

  /**
   * Open the file at one line in a real editor — for the reader who wants the
   * language server, or the rest of the file. It starts no review: the page is
   * still the surface that owns this file's regions.
   */
  private async openInEditor(file: string, line: number): Promise<void> {
    if (!this.review.has(file)) return;
    const at = Math.max(0, (typeof line === 'number' ? line : 1) - 1);
    const document = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(document, {
      preview: false,
      selection: new vscode.Range(at, 0, at, 0),
    });
  }

  private sendSet(): void {
    this.post(this.review.document(this.source.baselineLabel));
  }

  private send(posts: readonly Outbound[]): void {
    for (const post of posts) this.post(post);
  }

  private post(message: Outbound): void {
    void this.panel?.webview.postMessage(message);
  }

  // --- shell ------------------------------------------------------------------

  /**
   * The page's own HTML, with a nonce minted per load. Nothing loads from
   * anywhere but the extension's `media` folder, and the only script that runs
   * is the one carrying this load's nonce — an inline `<script>` injected into
   * the page by anything, including a file's own contents, has no way to run.
   */
  private html(webview: vscode.Webview): string {
    const nonce = randomNonce();
    const asset = (name: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', name));
    const template = fs.readFileSync(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'changeset.html').fsPath,
      'utf8'
    );
    return template
      .replace(/\{\{cspSource\}\}/g, webview.cspSource)
      .replace(/\{\{nonce\}\}/g, nonce)
      .replace(/\{\{style\}\}/g, String(asset('changeset.css')))
      .replace(/\{\{script\}\}/g, String(asset('changeset.js')));
  }

  dispose(): void {
    this.panel?.dispose();
    this.emitter.dispose();
  }
}

/** A deleted file reads as empty — reviewing it acknowledges the deletion. */
function readFile(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** Workspace-relative, forward slashes — the path the reader reads by. */
function relative(root: string, file: string): string {
  return path.relative(root, file).replace(/\\/g, '/');
}

function randomNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}
