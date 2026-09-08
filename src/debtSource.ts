import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { filesWithDebt, readBaseline } from './core/baselineStore';
import { diffLines, hasDebt } from './core/diff';
import { GitCommit, gitBaseline, gitChanges, gitLog } from './core/gitBaseline';
import { IGNORE_FILE, IgnoreRule, isIgnored, readIgnoreRules } from './core/ignoreFile';
import { isSensitivePath } from './core/sensitive';

/**
 * What the review compares against. Two modes over the same review flow:
 *
 * - `tracked` (default): the last-reviewed snapshot per file, the store the
 *   capture hook feeds. Debt is "changed since you last reviewed it".
 * - `git`: the file's content at a revision, HEAD by default. Debt is
 *   "changed since that revision", whether or not anything was tracking.
 *
 * Git mode is an override: switching to it replaces the list
 * and the diff baseline while the snapshot store sits untouched, so switching
 * back restores exactly the tracked debt that was there before. Reviewing a
 * file always advances its snapshot, in either mode — that is what lets a
 * reviewed file drop off both lists, and snapshots only ever move forward.
 */
export type DebtMode = 'tracked' | 'git';

export interface DebtRow {
  file: string;
  addedLines: number;
  removedLines: number;
  /** Nothing to compare against: the file is new since the baseline. */
  isNew: boolean;
}

const MODE_KEY = 'copyworkcode.debtMode';
const REF_KEY = 'copyworkcode.gitRevision';

/** Drop the remembered mode and revision, so the next source starts on the defaults. */
export async function forgetDebtChoices(state: vscode.Memento): Promise<void> {
  await state.update(MODE_KEY, undefined);
  await state.update(REF_KEY, undefined);
}

export class DebtSource implements vscode.Disposable {
  private emitter = new vscode.EventEmitter<void>();
  /** Fires when the mode changes, so views can re-read their rows. */
  readonly onDidChangeMode = this.emitter.event;

  constructor(
    private root: string,
    private state: vscode.Memento
  ) {
    void this.publishContext();
  }

  get mode(): DebtMode {
    return this.state.get<DebtMode>(MODE_KEY) === 'git' ? 'git' : 'tracked';
  }

  /**
   * Revision git mode compares the working tree against: a commit picked for
   * this workspace when there is one, else the setting.
   */
  get ref(): string {
    return this.pickedRef ?? this.configuredRef;
  }

  /** The setting's revision, which a picked commit stands in for. */
  get configuredRef(): string {
    const configured = vscode.workspace
      .getConfiguration('copyworkcode')
      .get<string>('gitRef', 'HEAD')
      .trim();
    return configured.length > 0 ? configured : 'HEAD';
  }

  /** The commit picked for this workspace, if any. */
  get pickedRef(): string | undefined {
    return this.state.get<string>(REF_KEY);
  }

  /**
   * Compare against `ref` from now on, or against the setting again when it is
   * `undefined`. Kept in the extension's workspace state, since a workspace
   * setting would be written into the project.
   */
  async setRef(ref: string | undefined): Promise<void> {
    if (ref === this.pickedRef) return;
    await this.state.update(REF_KEY, ref);
    this.emitter.fire();
  }

  /** True when git can resolve `ref` here. */
  revisionExists(ref: string): boolean {
    return gitChanges(this.root, ref) !== undefined;
  }

  /** Recent commits to offer as revisions. */
  recentCommits(limit: number): GitCommit[] | undefined {
    return gitLog(this.root, limit);
  }

  /** Names the compared-against side, for view headers and diff titles. */
  get baselineLabel(): string {
    return this.mode === 'git' ? this.ref : 'last reviewed';
  }

  async setMode(mode: DebtMode): Promise<void> {
    if (mode === this.mode) return;
    await this.state.update(MODE_KEY, mode);
    await this.publishContext();
    this.emitter.fire();
  }

  /** True when git can answer for this workspace at the configured revision. */
  gitAvailable(): boolean {
    return gitChanges(this.root, this.ref) !== undefined;
  }

  /** The content the review retypes over, or `undefined` when there is none. */
  baselineFor(file: string): string | undefined {
    return this.mode === 'git'
      ? gitBaseline(this.root, this.ref, file)
      : readBaseline(this.root, file);
  }

  /** Files waiting for review in the given mode, largest change first. */
  rows(mode: DebtMode = this.mode): DebtRow[] {
    const ignore = readIgnoreRules(this.root);
    const rows = (mode === 'git' ? this.gitRows() : this.trackedRows()).filter((row) =>
      this.queueable(row.file, ignore)
    );
    return rows.sort(
      (a, b) =>
        b.addedLines + b.removedLines - (a.addedLines + a.removedLines) ||
        a.file.localeCompare(b.file)
    );
  }

  /**
   * Files the compared revision still reports as changed that a completed
   * review is hiding. Git keeps reporting a change until it is committed, so
   * this is what a queue cleared by mistake can be rebuilt from.
   */
  reviewedHidden(): string[] {
    const changes = gitChanges(this.root, this.ref);
    if (!changes) return [];
    const ignore = readIgnoreRules(this.root);
    return changes
      .map((change) => change.file)
      .filter((file) => {
        const reviewed = readBaseline(this.root, file);
        return (
          reviewed !== undefined &&
          !hasDebt(reviewed, currentContent(file)) &&
          this.queueable(file, ignore)
        );
      });
  }

  /**
   * Reviewing writes the file's content to a baseline, so a credentials file
   * must never reach the queue in the first place. The capture hook already
   * declines to snapshot one; this covers the two ways a file can arrive
   * without having gone through it — a baseline written before the exclusion
   * existed, and git mode, which reports what changed whether or not anything
   * was capturing. The ignore file keeps out what the reviewer asked to never
   * see, and itself: a line added to it is not a review.
   */
  private queueable(file: string, ignore: IgnoreRule[]): boolean {
    const rel = path.relative(this.root, file);
    return !isSensitivePath(rel) && rel !== IGNORE_FILE && !isIgnored(rel, ignore);
  }

  private trackedRows(): DebtRow[] {
    return filesWithDebt(this.root).map((debt) => {
      const hunks = diffLines(debt.baseline, debt.current);
      return {
        file: debt.file,
        addedLines: hunks.reduce((n, h) => n + h.addedLines.length, 0),
        removedLines: hunks.reduce((n, h) => n + h.removedLines.length, 0),
        isNew: debt.baseline.length === 0,
      };
    });
  }

  private gitRows(): DebtRow[] {
    const changes = gitChanges(this.root, this.ref);
    if (!changes) return [];
    const rows: DebtRow[] = [];
    for (const change of changes) {
      // Already reviewed and untouched since: its snapshot still matches the
      // file on disk, so the row would be a stale reminder of cleared work.
      // Git itself keeps reporting it until the change is committed.
      const reviewed = readBaseline(this.root, change.file);
      if (reviewed !== undefined && !hasDebt(reviewed, currentContent(change.file))) {
        continue;
      }
      rows.push({
        file: change.file,
        addedLines: change.addedLines,
        removedLines: change.removedLines,
        isNew: change.untracked,
      });
    }
    return rows;
  }

  private async publishContext(): Promise<void> {
    await vscode.commands.executeCommand(
      'setContext',
      'copyworkcode.debtMode',
      this.mode
    );
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

/** A deleted file reads as empty — reviewing it acknowledges the deletion. */
function currentContent(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}
