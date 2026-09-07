import * as fs from 'fs';
import * as vscode from 'vscode';
import { ReviewRecord } from './types';
import { statePath } from './core/paths';

/**
 * The personal review log, persisted to the workspace's `state.json`: one record
 * per completed review (typed or skipped), append-only. This is a private
 * mirror for the user's own discipline — plain local JSON, no tamper-evidence
 * by design (see design.md, "Review stats").
 */
export class ReviewLog implements vscode.Disposable {
  private records: ReviewRecord[] = [];
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private root: string) {
    this.load();
  }

  add(record: ReviewRecord): void {
    this.records.push(record);
    this.save();
    this.emitter.fire();
  }

  lastFor(file: string): ReviewRecord | undefined {
    for (let i = this.records.length - 1; i >= 0; i--) {
      if (this.records[i].file === file) return this.records[i];
    }
    return undefined;
  }

  all(): readonly ReviewRecord[] {
    return this.records;
  }

  private load(): void {
    try {
      const data = JSON.parse(fs.readFileSync(statePath(this.root), 'utf8'));
      if (Array.isArray(data.reviews)) {
        this.records = data.reviews;
      }
    } catch {
      // First run or unreadable state: empty log.
    }
  }

  private save(): void {
    fs.writeFileSync(
      statePath(this.root),
      JSON.stringify({ reviews: this.records }, null, 2) + '\n'
    );
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
