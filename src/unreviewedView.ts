import * as path from 'path';
import * as vscode from 'vscode';
import { ChangeEvent } from './types';
import { EventQueue } from './eventQueue';
import { ReviewState } from './reviewState';

/** Explorer view listing changes still waiting to be reviewed, newest first. */
export class UnreviewedTreeProvider
  implements vscode.TreeDataProvider<ChangeEvent>
{
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(
    private root: string,
    private queue: EventQueue,
    private state: ReviewState
  ) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(event: ChangeEvent): vscode.TreeItem {
    const item = new vscode.TreeItem(path.basename(event.file));
    const relative = path.relative(this.root, path.dirname(event.file));
    const when = new Date(event.timestamp).toLocaleTimeString();
    item.description = `${relative || '.'} — ${event.toolName ?? event.source} ${when}`;
    item.tooltip = event.file;
    item.contextValue = 'copyworkcode.change';
    item.command = {
      command: 'copyworkcode.reviewChange',
      title: 'Review Change',
      arguments: [event],
    };
    return item;
  }

  getChildren(element?: ChangeEvent): ChangeEvent[] {
    if (element) return [];
    return this.queue.events
      .filter((e) => this.state.statusOf(e.id) === 'unreviewed')
      .slice()
      .reverse();
  }
}
