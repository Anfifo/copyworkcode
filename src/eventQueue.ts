import * as fs from 'fs';
import * as vscode from 'vscode';
import { ChangeEvent } from './types';
import { DATA_DIR, EVENTS_FILE, eventsPath } from './core/paths';
import { parseEventChunk } from './core/eventLog';

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

  /** Events for one file, newest last, optionally only after a given time. */
  eventsFor(file: string, after?: string): ChangeEvent[] {
    return this.events.filter(
      (e) => e.file === file && (!after || e.timestamp > after)
    );
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

    const { events, remainder } = parseEventChunk(
      chunk,
      this.remainder,
      this.seen
    );
    this.remainder = remainder;
    if (events.length > 0) {
      this.events.push(...events);
      this.emitter.fire(events);
    }
  }

  dispose(): void {
    this.watcher?.dispose();
    this.emitter.dispose();
  }
}
