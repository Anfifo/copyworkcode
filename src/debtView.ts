import * as path from 'path';
import * as vscode from 'vscode';
import { filesWithDebt } from './core/baselineStore';
import { diffLines } from './core/diff';
import { EventQueue } from './eventQueue';
import { ReviewLog } from './reviewState';

/**
 * Explorer view listing files with review debt: current content differs from
 * the last-reviewed baseline. Captured agent events annotate each file item;
 * they are not the unit of review themselves.
 */
export class DebtTreeProvider implements vscode.TreeDataProvider<string> {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private root: string,
    private queue: EventQueue,
    private log: ReviewLog
  ) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(file: string): vscode.TreeItem {
    const item = new vscode.TreeItem(path.basename(file));
    const relativeDir = path.relative(this.root, path.dirname(file));

    const debt = filesWithDebt(this.root).find((d) => d.file === file);
    let stats = '';
    if (debt) {
      const hunks = diffLines(debt.baseline, debt.current);
      const added = hunks.reduce((n, h) => n + h.addedLines.length, 0);
      const removed = hunks.reduce((n, h) => n + h.removedLines.length, 0);
      stats = `+${added} −${removed}`;
    }
    const since = this.log.lastFor(file)?.at;
    const events = this.queue.eventsFor(file, since).length;
    const agentNote = events > 0 ? ` · ${events} agent edit(s)` : '';

    item.description = `${relativeDir || '.'} — ${stats}${agentNote}`;
    item.tooltip = file;
    item.resourceUri = vscode.Uri.file(file);
    item.contextValue = 'copyworkcode.file';
    item.command = {
      command: 'copyworkcode.reviewFile',
      title: 'Review by Retyping',
      arguments: [file],
    };
    return item;
  }

  getChildren(element?: string): string[] {
    if (element) return [];
    return filesWithDebt(this.root)
      .map((d) => d.file)
      .sort();
  }
}
