import * as path from 'path';
import * as vscode from 'vscode';
import { DebtRow, DebtSource } from './debtSource';
import { EventQueue } from './eventQueue';
import { ReviewProgress } from './retypeController';
import { ReviewLog } from './reviewState';

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
 * compared against, so a switched baseline is never a silent change, and the
 * container badge carries the pending count.
 */
export class DebtTreeProvider implements vscode.TreeDataProvider<string> {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  /** Rows of the last computed list, for the item builder to read back. */
  private rows = new Map<string, DebtRow>();
  private view?: vscode.TreeView<string>;

  constructor(
    private root: string,
    private source: DebtSource,
    private queue: EventQueue,
    private log: ReviewLog,
    private progressFor: (file: string) => ReviewProgress | undefined,
    private decorations?: DebtDecorations
  ) {}

  /** The header and badge live on the view, not on its items. */
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
    this.updateHeader(rows.length);
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

    const bits = [`+${added} −${removed}`];
    if (progress) {
      bits.push(`reviewing ${progress.claimed}/${progress.total}`);
    }
    if (events > 0) {
      bits.push(`${events} edit(s)`);
    }
    bits.push(relativeDir(this.root, file));
    item.description = bits.join(' · ');

    item.tooltip = this.tooltip(file, added, removed, events, progress, row);
    item.contextValue = 'copyworkcode.file';
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
    progress: ReviewProgress | undefined,
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
      lines.push(
        `Under review now: ${progress.claimed} of ${progress.total} section(s) claimed.`
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
 * Colours the filename of a queued file by the shape of its change: added,
 * deleted, or both. A tree row cannot colour part of its own text, so the
 * `+N −M` counts stay in the row's uncoloured description — a native tree view
 * has no way to tint them, and rebuilding the queue as a webview to get it
 * would cost the file-icon theme, the container badge, and the welcome content.
 *
 * The same tint reaches the Explorer and the editor tabs, since decorations are
 * per-URI and not per-view. That is a side effect rather than the goal, but a
 * welcome one: a file with unreviewed changes reads as one everywhere.
 */
export class DebtDecorations
  implements vscode.FileDecorationProvider, vscode.Disposable
{
  private emitter = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  private shapes = new Map<string, DebtRow>();

  update(rows: readonly DebtRow[]): void {
    const touched = new Set([...this.shapes.keys()]);
    const next = new Map<string, DebtRow>();
    for (const row of rows) {
      next.set(row.file, row);
      touched.add(row.file);
    }
    this.shapes = next;
    this.emitter.fire([...touched].map((file) => vscode.Uri.file(file)));
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const row = this.shapes.get(uri.fsPath);
    if (!row) return undefined;
    if (row.addedLines > 0 && row.removedLines === 0) {
      return decoration('addedResourceForeground', 'added, not yet reviewed');
    }
    if (row.removedLines > 0 && row.addedLines === 0) {
      return decoration('deletedResourceForeground', 'deletions not yet reviewed');
    }
    return decoration('modifiedResourceForeground', 'changed, not yet reviewed');
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

function decoration(color: string, tooltip: string): vscode.FileDecoration {
  const value = new vscode.FileDecoration(undefined, `CopyWorkCode: ${tooltip}`);
  value.color = new vscode.ThemeColor(`gitDecoration.${color}`);
  return value;
}

function relativeDir(root: string, file: string): string {
  const dir = path.relative(root, path.dirname(file)).replace(/\\/g, '/');
  return dir.length > 0 ? dir : '.';
}
