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
 * by, then the coverage of a review live on that file, and carries the colour of
 * the change on its icon: a tree row cannot colour its own text, so the icon
 * does that work. The view header names what the rows are being compared
 * against, so a switched baseline is never a silent change, and the container
 * badge carries the pending count.
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
    private progressFor: (file: string) => ReviewProgress | undefined
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
    item.iconPath = changeIcon(added, removed);

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

/** The row's only coloured surface: what kind of change is waiting. */
function changeIcon(added: number, removed: number): vscode.ThemeIcon {
  if (added > 0 && removed === 0) {
    return new vscode.ThemeIcon(
      'diff-added',
      new vscode.ThemeColor('gitDecoration.addedResourceForeground')
    );
  }
  if (removed > 0 && added === 0) {
    return new vscode.ThemeIcon(
      'diff-removed',
      new vscode.ThemeColor('gitDecoration.deletedResourceForeground')
    );
  }
  return new vscode.ThemeIcon(
    'diff-modified',
    new vscode.ThemeColor('gitDecoration.modifiedResourceForeground')
  );
}

function relativeDir(root: string, file: string): string {
  const dir = path.relative(root, path.dirname(file)).replace(/\\/g, '/');
  return dir.length > 0 ? dir : '.';
}
