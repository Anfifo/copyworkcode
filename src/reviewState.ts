import * as fs from 'fs';
import * as vscode from 'vscode';
import { ReviewStatus } from './types';
import { statePath } from './workspaceData';

/**
 * Review status per change event, persisted to `.copyworkcode/state.json`.
 * Kept separate from the event log so events stay append-only and the log can
 * be regenerated or trimmed without losing review history.
 */
export class ReviewState implements vscode.Disposable {
  private statuses = new Map<string, ReviewStatus>();
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private root: string) {
    this.load();
  }

  statusOf(eventId: string): ReviewStatus {
    return this.statuses.get(eventId) ?? 'unreviewed';
  }

  setStatus(eventId: string, status: ReviewStatus): void {
    this.statuses.set(eventId, status);
    this.save();
    this.emitter.fire();
  }

  private load(): void {
    try {
      const data = JSON.parse(fs.readFileSync(statePath(this.root), 'utf8'));
      for (const [id, status] of Object.entries(data.statuses ?? {})) {
        this.statuses.set(id, status as ReviewStatus);
      }
    } catch {
      // First run or unreadable state: everything defaults to unreviewed.
    }
  }

  private save(): void {
    const data = { statuses: Object.fromEntries(this.statuses) };
    fs.writeFileSync(
      statePath(this.root),
      JSON.stringify(data, null, 2) + '\n'
    );
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
