import * as vscode from 'vscode';
import { diffLines } from './core/diff';
import { DebtSource } from './debtSource';

/**
 * Marks the changed regions of any open file against its review baseline, with
 * no typing session involved. This is the tool at rest: open a file an agent
 * touched and the parts that changed are visibly the parts that changed, so
 * "an easier way to look at the recent changes" needs no commitment to review
 * anything.
 *
 * It keeps the review's polarity — changed code is the dimmed side, because
 * that is what typing over it undims — but at a lighter dim than a review uses,
 * so the two never read as the same state. Full dim keeps its one meaning:
 * under review, still owed. A gutter icon and an overview-ruler mark come with
 * it, since a dim alone is invisible while scrolling past.
 *
 * The reviewed file is deliberately excluded: its own overlay is the authority
 * there, and two dimming layers over one buffer would compound into a third
 * shade that means nothing.
 */
export class AmbientDebt implements vscode.Disposable {
  private changed: vscode.TextEditorDecorationType;
  private guards: vscode.Disposable[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  /** Documents whose text was already diffed, keyed by content version, so
   * repainting on a cursor-only event costs nothing. */
  private cache = new Map<string, { version: number; ranges: vscode.Range[] }>();

  constructor(
    private source: DebtSource,
    /** The document under review, which owns its own rendering. */
    private reviewed: () => vscode.TextDocument | undefined,
    iconRoot: vscode.Uri
  ) {
    this.changed = vscode.window.createTextEditorDecorationType({
      opacity: '0.72',
      gutterIconPath: vscode.Uri.joinPath(iconRoot, 'media', 'hunk.svg'),
      gutterIconSize: 'contain',
      overviewRulerColor: new vscode.ThemeColor(
        'gitDecoration.modifiedResourceForeground'
      ),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });

    this.guards.push(
      vscode.window.onDidChangeVisibleTextEditors(() => this.schedule()),
      // Editing a file changes what counts as changed, but redoing the diff on
      // every keystroke would be pointless work: coalesce to the pause.
      vscode.workspace.onDidChangeTextDocument((e) => {
        this.cache.delete(e.document.uri.toString());
        this.schedule();
      }),
      vscode.workspace.onDidSaveTextDocument(() => this.schedule()),
      vscode.workspace.onDidCloseTextDocument((document) =>
        this.cache.delete(document.uri.toString())
      ),
      this.source.onDidChangeMode(() => this.invalidate()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration('copyworkcode.ambientHighlight') ||
          e.affectsConfiguration('copyworkcode.gitRef')
        ) {
          this.invalidate();
        }
      })
    );
    this.schedule(0);
  }

  /** Baselines moved (a review completed, a file was skipped): everything
   * previously diffed is suspect. */
  invalidate(): void {
    this.cache.clear();
    this.schedule(0);
  }

  private schedule(delay = 250): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.paint();
    }, delay);
  }

  private paint(): void {
    const on = vscode.workspace
      .getConfiguration('copyworkcode')
      .get<boolean>('ambientHighlight', true);
    const reviewed = this.reviewed();
    for (const editor of vscode.window.visibleTextEditors) {
      const document = editor.document;
      const skip =
        !on || document === reviewed || document.uri.scheme !== 'file';
      editor.setDecorations(this.changed, skip ? [] : this.rangesFor(document));
    }
  }

  private rangesFor(document: vscode.TextDocument): vscode.Range[] {
    const key = document.uri.toString();
    const hit = this.cache.get(key);
    if (hit && hit.version === document.version) return hit.ranges;

    const ranges = this.diff(document);
    this.cache.set(key, { version: document.version, ranges });
    return ranges;
  }

  private diff(document: vscode.TextDocument): vscode.Range[] {
    const baseline = this.source.baselineFor(document.uri.fsPath);
    if (baseline === undefined) return [];
    const current = document.getText();
    // A file this large is not something anyone reads a change into, and the
    // diff is quadratic in the changed region.
    if (current.length > MAX_CHARS) return [];

    const ranges: vscode.Range[] = [];
    for (const hunk of diffLines(baseline, current)) {
      if (hunk.addedLines.length === 0) continue;
      const last = Math.min(
        hunk.currentStart + hunk.addedLines.length - 1,
        document.lineCount - 1
      );
      if (hunk.currentStart > last) continue;
      ranges.push(
        new vscode.Range(
          hunk.currentStart,
          0,
          last,
          document.lineAt(last).text.length
        )
      );
    }
    return ranges;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const guard of this.guards) guard.dispose();
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.changed, []);
    }
    this.changed.dispose();
    this.cache.clear();
  }
}

const MAX_CHARS = 400_000;
