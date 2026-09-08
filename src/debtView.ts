import * as path from 'path';
import * as vscode from 'vscode';
import { DebtRow, DebtSource } from './debtSource';
import { EventQueue } from './eventQueue';
import { ReviewLog } from './reviewState';

/**
 * What a row says about a file someone is part way through — in the queue's own
 * vocabulary, not either surface's. Both surfaces report coverage the same way;
 * only the row has to name which one to go back to, since a reviewer sent to the
 * editor for a file the page holds would find nothing there and start again.
 */
export interface RowProgress {
  claimed: number;
  total: number;
  /** `reviewing` — the editor review running now. `paused` — an editor review
   * the reviewer stepped away from. `page` — the change set page. */
  state: 'reviewing' | 'paused' | 'page';
}

/**
 * The review queue: one row per file whose content differs from what it is
 * compared against (the last-reviewed snapshot, or a git revision — see
 * DebtSource). Captured agent events annotate a row; they are not the unit of
 * review themselves.
 *
 * Each row leads with the change size, because that is what the reviewer picks
 * by, and keeps the file-icon theme's own icon so a row still reads as the kind
 * of file it is. The colour of the change goes on the filename instead, via the
 * decoration provider below. The view header names what the rows are being
 * compared against, so a switched baseline announces itself, and the
 * container badge carries the pending count.
 */
export class DebtTreeProvider implements vscode.TreeDataProvider<string> {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  /** Rows of the last computed list, for the item builder to read back. */
  private rows = new Map<string, DebtRow>();
  /** Filenames the queue is showing more than once, so those rows can name
   * their folder and the rest can stay short. */
  private ambiguous = new Set<string>();
  private view?: vscode.TreeView<string>;

  constructor(
    private root: string,
    private source: DebtSource,
    private queue: EventQueue,
    private log: ReviewLog,
    private progressFor: (file: string) => RowProgress | undefined,
    private decorations?: DebtDecorations
  ) {}

  /** The header and badge live on the view object, so the provider needs it. */
  attach(view: vscode.TreeView<string>): void {
    this.view = view;
  }

  refresh(): void {
    this.emitter.fire();
  }

  getChildren(element?: string): string[] {
    if (element) return [];
    const rows = this.source.rows();
    this.rows = new Map(rows.map((row) => [row.file, row]));
    this.ambiguous = duplicateNames(rows.map((row) => row.file));
    this.updateHeader(rows.length);
    if (this.source.mode === 'git' && rows.length === 0) {
      // The empty git welcome offers the tracked queue only while that
      // queue has rows, so its link never lands on another empty view.
      void vscode.commands.executeCommand(
        'setContext',
        'copyworkcode.trackedDebt',
        this.source.rows('tracked').length > 0
      );
    }
    // The rows are diffed here anyway; handing them on is what keeps the
    // filename tint from having to recompute the whole queue for itself.
    this.decorations?.update(rows);
    return rows.map((row) => row.file);
  }

  getTreeItem(file: string): vscode.TreeItem {
    const row = this.rows.get(file);
    const added = row?.addedLines ?? 0;
    const removed = row?.removedLines ?? 0;
    const events = this.queue.eventsFor(file, this.log.lastFor(file)?.at).length;
    const progress = this.progressFor(file);

    const item = new vscode.TreeItem(path.basename(file));
    item.resourceUri = vscode.Uri.file(file);

    // The row says what changed and, while something is reviewing it, how far
    // that has got. Everything else — the edit count, the full path — is in the
    // tooltip, which is where a fact someone goes looking for belongs. A
    // description is read at a glance down a column of rows in a panel usually
    // docked narrow, so each thing on it costs the others their room.
    const bits = [`+${added} −${removed}`];
    if (progress) {
      // Two of the three states are already the word the row wants.
      const where = progress.state === 'page' ? 'on the page' : progress.state;
      bits.push(`${where} ${progress.claimed}/${progress.total}`);
    }
    // The folder is shown only when the filename does not settle which
    // file this is — the same rule the workbench applies to its editor tabs.
    const dir = this.ambiguous.has(path.basename(file))
      ? relativeDir(this.root, file)
      : '';
    if (dir) bits.push(dir);
    item.description = bits.join(' · ');

    item.tooltip = this.tooltip(file, added, removed, events, progress, row);
    // A row with an editor review on it, running or paused, answers to one
    // action the others cannot: there is no progress to reset on a file whose
    // review hasn't started. Reset belongs to that surface — it puts the file
    // back to the version handed over for review — so a row the page holds is
    // not offered it.
    item.contextValue =
      progress && progress.state !== 'page'
        ? 'copyworkcode.file.reviewing'
        : 'copyworkcode.file';
    item.command = {
      command: 'copyworkcode.reviewFile',
      title: 'Review by Retyping',
      arguments: [file],
    };
    return item;
  }

  private tooltip(
    file: string,
    added: number,
    removed: number,
    events: number,
    progress: RowProgress | undefined,
    row: DebtRow | undefined
  ): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.supportThemeIcons = true;
    const lines = [
      `**${path.relative(this.root, file).replace(/\\/g, '/')}**`,
      `${added} line(s) added, ${removed} removed since ${this.source.baselineLabel}`,
    ];
    if (row?.isNew) {
      lines.push('New file — the whole file is one section.');
    }
    if (progress) {
      // Each surface keeps its own word for a unit of review: the editor walks
      // sections of a buffer, the page draws regions of a document.
      lines.push(
        progress.state === 'reviewing'
          ? `Under review now: ${progress.claimed} of ${progress.total} section(s) claimed.`
          : progress.state === 'paused'
            ? `Review paused: ${progress.claimed} of ${progress.total} section(s) ` +
              'claimed, waiting where you left it.'
            : `On the change set page: ${progress.claimed} of ${progress.total} ` +
              'region(s) claimed.'
      );
    }
    if (events > 0) {
      lines.push(`${events} agent edit(s) recorded since the last review.`);
    }
    const last = this.log.lastFor(file);
    lines.push(
      last
        ? `Last reviewed ${new Date(last.at).toLocaleString()} (${last.outcome}).`
        : 'Never reviewed.'
    );
    md.appendMarkdown(lines.join('\n\n'));
    return md;
  }

  private updateHeader(count: number): void {
    const view = this.view;
    if (!view) return;
    view.description =
      this.source.mode === 'git' ? `git · ${this.source.ref}` : undefined;
    view.badge =
      count > 0
        ? { value: count, tooltip: `${count} file(s) waiting for review` }
        : undefined;
  }
}

/**
 * Tints the filename of the one file being reviewed in an editor right now.
 * A review the reviewer stepped away from is not that file, and
 * neither is one the change set page holds: both say how far they got in words,
 * and the one hue the panel has stays on the question of where the reviewer
 * is. The page is not somewhere the queue can point them anyway — it is already
 * open in front of them, showing its own progress on every file at once. There
 * is no "reviewed" colour either: a finished file leaves the queue on its own.
 *
 * A tree row cannot colour part of its own text, so the counts stay in the
 * row's uncoloured description — a native tree view has no way to tint them,
 * and rebuilding the queue as a webview to get it would cost the file-icon
 * theme, the container badge, and the welcome content.
 *
 * The tint reaches the Explorer and the editor tabs too, since decorations are
 * per-URI and not per-view: while a review is open, that file reads as the one
 * being worked on wherever it appears.
 */
export class DebtDecorations
  implements vscode.FileDecorationProvider, vscode.Disposable
{
  private emitter = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  /** Queued files, as the ledger of which URIs to re-ask about. The tint no
   * longer depends on a row's contents, only on which file is under review. */
  private queued = new Set<string>();

  constructor(private underReview: (file: string) => boolean) {}

  update(rows: readonly DebtRow[]): void {
    // Rows that just left the queue have to be re-asked about as well, or a
    // reviewed file keeps its tint until something else invalidates it.
    const touched = new Set(this.queued);
    this.queued = new Set(rows.map((row) => row.file));
    for (const file of this.queued) touched.add(file);
    this.emitter.fire([...touched].map((file) => vscode.Uri.file(file)));
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (!this.underReview(uri.fsPath)) return undefined;
    const value = new vscode.FileDecoration(
      undefined,
      'CopyWorkCode: being reviewed now'
    );
    // The workbench's own list warning colour: the yellow a tree row is meant
    // to use, so it lands as yellow in a theme. A literal value would be a
    // guess at one.
    value.color = new vscode.ThemeColor('list.warningForeground');
    return value;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

/** Filenames more than one row in the queue is using, so only those rows have
 * to say which folder they came from. */
function duplicateNames(files: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const file of files) {
    const name = path.basename(file);
    if (seen.has(name)) twice.add(name);
    seen.add(name);
  }
  return twice;
}

/** The folder a file sits in, workspace-relative — empty at the root itself. */
function relativeDir(root: string, file: string): string {
  return path.relative(root, path.dirname(file)).replace(/\\/g, '/');
}
