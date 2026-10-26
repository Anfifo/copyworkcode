import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { baselineWrittenAt } from './core/baselineStore';
import { Flag, PlacedFlag, parseFlags, placeFlags } from './core/flags';
import { FLAGS_FILE, dataDir, flagsPath } from './core/paths';

/**
 * The flags the agent has made in this workspace, read from `flags.jsonl` and
 * followed as the flag tool appends to it. The file is small and read whole on
 * every change. A flag counts only while the change it was about is still up
 * for review: once the file's baseline has been written after it, by a review
 * that finished, the flag was about a version nobody is reviewing any more.
 */
export class FlagStore implements vscode.Disposable {
  private flags: Flag[] = [];
  private watcher?: vscode.FileSystemWatcher;
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private root: string) {}

  start(): void {
    this.read();
    this.watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(dataDir(this.root)), FLAGS_FILE)
    );
    this.watcher.onDidChange(() => this.reread());
    this.watcher.onDidCreate(() => this.reread());
  }

  /** Flags about the file's change as it stands, oldest first. */
  flagsFor(file: string): Flag[] {
    const since = baselineWrittenAt(this.root, file);
    return this.flags.filter(
      (flag) =>
        samePath(flag.file, file) &&
        (since === undefined || Date.parse(flag.timestamp) >= since)
    );
  }

  /** Those flags placed in `content`, dropping any whose excerpt is gone. */
  placedFor(file: string, content: string): PlacedFlag[] {
    return placeFlags(content, this.flagsFor(file));
  }

  private read(): void {
    try {
      this.flags = parseFlags(fs.readFileSync(flagsPath(this.root), 'utf8'));
    } catch {
      this.flags = []; // no flags yet
    }
  }

  private reread(): void {
    this.read();
    this.emitter.fire();
  }

  dispose(): void {
    this.watcher?.dispose();
    this.emitter.dispose();
  }
}

function samePath(a: string, b: string): boolean {
  const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
  const fold = (p: string) => (caseInsensitive ? path.resolve(p).toLowerCase() : path.resolve(p));
  return fold(a) === fold(b);
}
