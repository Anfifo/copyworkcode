import * as fs from 'fs';
import * as vscode from 'vscode';
import { ChangeEvent } from './types';
import { DATA_DIR, EVENTS_FILE, eventsPath } from './workspaceData';

/**
 * Tails `.copyworkcode/events.jsonl` for the workspace: reads everything on
 * startup (catching up on sessions that ran while the editor was closed), then
 * follows appends via a file watcher. Events are deduplicated by id, and the
 * log itself is never modified.
 */
export class EventQueue implements vscode.Disposable {
  readonly events: ChangeEvent[] = [];

  private offset = 0;
  private remainder = '';
  private seen = new Set<string>();
  private watcher?: vscode.FileSystemWatcher;
  private emitter = new vscode.EventEmitter<ChangeEvent[]>();
  readonly onDidAddEvents = this.emitter.event;

  constructor(private root: string) {}

  start(): void {
    this.readNew();
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.root, `${DATA_DIR}/${EVENTS_FILE}`)
    );
    this.watcher.onDidChange(() => this.readNew());
    this.watcher.onDidCreate(() => this.readNew());
  }

  private readNew(): void {
    const file = eventsPath(this.root);
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return; // no events yet
    }
    if (size < this.offset) {
      // Log was replaced; start over (dedup by id keeps events unique).
      this.offset = 0;
      this.remainder = '';
    }
    if (size === this.offset) {
      return;
    }

    const fd = fs.openSync(file, 'r');
    let chunk: string;
    try {
      const buf = Buffer.alloc(size - this.offset);
      fs.readSync(fd, buf, 0, buf.length, this.offset);
      chunk = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    this.offset = size;

    const lines = (this.remainder + chunk).split('\n');
    this.remainder = lines.pop() ?? '';

    const fresh: ChangeEvent[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      let event: ChangeEvent;
      try {
        event = JSON.parse(line);
      } catch {
        continue; // tolerate a corrupt line rather than losing the tail
      }
      if (!event.id || this.seen.has(event.id)) continue;
      this.seen.add(event.id);
      this.events.push(event);
      fresh.push(event);
    }
    if (fresh.length > 0) {
      this.emitter.fire(fresh);
    }
  }

  dispose(): void {
    this.watcher?.dispose();
    this.emitter.dispose();
  }
}
