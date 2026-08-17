import * as path from 'path';
import * as vscode from 'vscode';
import { diffLines } from './core/diff';
import { RetypeEngine } from './core/retype';
import { advanceBaseline, readBaseline } from './core/baselineStore';
import { ReviewLog } from './reviewState';

export const BASELINE_SCHEME = 'copyworkcode-baseline';

/** Left-hand side of the review diff: the file's baseline snapshot. */
export function baselineUri(file: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: BASELINE_SCHEME,
    path: `/${path.basename(file)} (last reviewed)`,
    query: file,
  });
}

interface HunkTask {
  /** Offsets of the hunk in the document at review start. Stable while the
   * hunk before it is fully restored, which the flow guarantees. */
  startOffset: number;
  endOffset: number;
  /** Exact document text of the range — retyping reproduces it byte for byte. */
  target: string;
}

interface Session {
  root: string;
  file: string;
  document: vscode.TextDocument;
  /** Full content at review start, for aborting back to a known state. */
  originalContent: string;
  tasks: HunkTask[];
  index: number;
  engine: RetypeEngine;
  hunksTyped: number;
  hunksSkipped: number;
  /** True once any keystroke was accepted in the current hunk. */
  currentHunkTyped: boolean;
  /** Guards the foreign-change detector against our own edits. */
  applying: boolean;
}

/**
 * Drives the guided retype for one file: opens a diff against the baseline,
 * then walks the changed sections top to bottom. Each section's new text is
 * removed from the buffer and the user types it back in, validated by the
 * matching engine. Typing is intercepted with a `type` command override, so
 * completions, snippets and auto-closing pairs never insert text on the
 * user's behalf inside the review.
 */
export class RetypeController implements vscode.Disposable {
  private session?: Session;
  private typeOverride?: vscode.Disposable;
  private emitter = new vscode.EventEmitter<void>();
  /** Fires when a review finishes, aborts, or is otherwise torn down. */
  readonly onDidFinish = this.emitter.event;

  private ghost = vscode.window.createTextEditorDecorationType({
    after: {
      color: new vscode.ThemeColor('editorGhostText.foreground'),
      fontStyle: 'italic',
    },
  });
  private statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  private changeGuard: vscode.Disposable;

  constructor(private log: ReviewLog) {
    this.changeGuard = vscode.workspace.onDidChangeTextDocument((e) => {
      const s = this.session;
      if (s && e.document === s.document && !s.applying && e.contentChanges.length > 0) {
        void this.abort(
          'CopyWorkCode: review stopped — the file changed outside the retype flow. Content restored.'
        );
      }
    });
  }

  get reviewing(): boolean {
    return this.session !== undefined;
  }

  async start(root: string, file: string): Promise<void> {
    if (this.session) {
      void vscode.window.showWarningMessage(
        'CopyWorkCode: a review is already in progress.'
      );
      return;
    }
    const baseline = readBaseline(root, file);
    if (baseline === undefined) {
      void vscode.window.showInformationMessage(
        'CopyWorkCode: no tracked changes for this file.'
      );
      return;
    }

    const document = await vscode.workspace.openTextDocument(file);
    const current = document.getText();
    const hunks = diffLines(baseline, current).filter(
      (h) => h.addedLines.length > 0
    );

    await vscode.commands.executeCommand(
      'vscode.diff',
      baselineUri(file),
      document.uri,
      `${path.basename(file)} (review)`,
      { preview: false }
    );

    if (hunks.length === 0) {
      // Deletions or line-ending changes only: read the diff, confirm.
      const action = await vscode.window.showInformationMessage(
        'CopyWorkCode: only removals or formatting since the last review. Mark as reviewed?',
        'Mark Reviewed'
      );
      if (action === 'Mark Reviewed') {
        advanceBaseline(root, file, current);
        this.log.add({
          file,
          at: new Date().toISOString(),
          outcome: 'typed',
          hunksTyped: 0,
          hunksSkipped: 0,
        });
        this.emitter.fire();
      }
      return;
    }

    const tasks: HunkTask[] = hunks.map((h) => {
      const startOffset = document.offsetAt(new vscode.Position(h.currentStart, 0));
      const endOffset = document.offsetAt(
        new vscode.Position(h.currentStart + h.addedLines.length, 0)
      );
      return { startOffset, endOffset, target: current.slice(startOffset, endOffset) };
    });

    this.session = {
      root,
      file,
      document,
      originalContent: current,
      tasks,
      index: 0,
      engine: new RetypeEngine(tasks[0].target),
      hunksTyped: 0,
      hunksSkipped: 0,
      currentHunkTyped: false,
      applying: false,
    };

    try {
      this.typeOverride = vscode.commands.registerCommand('type', (args) =>
        this.onType(args)
      );
    } catch {
      // Another extension owns `type` (e.g. a modal-editing plugin): retype
      // can't validate keystrokes, so don't pretend to review.
      this.session = undefined;
      void vscode.window.showErrorMessage(
        'CopyWorkCode: another extension intercepts typing; guided retype is unavailable.'
      );
      return;
    }

    await vscode.commands.executeCommand('setContext', 'copyworkcode.reviewing', true);
    await this.beginHunk();
  }

  private async beginHunk(): Promise<void> {
    const s = this.session;
    if (!s) return;
    const task = s.tasks[s.index];
    s.engine = new RetypeEngine(task.target);
    s.currentHunkTyped = false;
    await this.applyChange((edit) => {
      edit.delete(
        s.document.uri,
        new vscode.Range(
          s.document.positionAt(task.startOffset),
          s.document.positionAt(task.endOffset)
        )
      );
    });
    this.moveCursor();
    this.updateUi();
  }

  private async onType(args: { text: string }): Promise<void> {
    const s = this.session;
    const editor = vscode.window.activeTextEditor;
    if (!s || !editor || editor.document !== s.document) {
      await vscode.commands.executeCommand('default:type', args);
      return;
    }
    const result = s.engine.handleInput(args.text ?? '');
    if (result.kind === 'reject') {
      this.updateUi(true);
      return;
    }
    s.currentHunkTyped = true;
    await this.insertAccepted(result.text);
  }

  /** Insert text the engine already accounted for, then advance the flow. */
  private async insertAccepted(text: string): Promise<void> {
    const s = this.session;
    if (!s || text.length === 0) {
      await this.maybeCompleteHunk();
      return;
    }
    const task = s.tasks[s.index];
    const at = s.document.positionAt(
      task.startOffset + s.engine.position - text.length
    );
    await this.applyChange((edit) => edit.insert(s.document.uri, at, text));
    this.moveCursor();
    this.updateUi();
    await this.maybeCompleteHunk();
  }

  private async maybeCompleteHunk(): Promise<void> {
    const s = this.session;
    if (!s || !s.engine.done) return;
    if (s.currentHunkTyped) {
      s.hunksTyped++;
    } else {
      s.hunksSkipped++;
    }
    s.index++;
    if (s.index < s.tasks.length) {
      await this.beginHunk();
    } else {
      await this.finish();
    }
  }

  async skipSection(): Promise<void> {
    const s = this.session;
    if (!s) return;
    s.currentHunkTyped = false;
    await this.insertAccepted(s.engine.fillRest());
  }

  async fillNextLine(): Promise<void> {
    const s = this.session;
    if (!s) return;
    await this.insertAccepted(s.engine.fillLine());
  }

  async abort(message?: string): Promise<void> {
    const s = this.session;
    if (!s) return;
    this.session = undefined; // stop the foreign-change guard first
    const full = new vscode.Range(
      s.document.positionAt(0),
      s.document.positionAt(s.document.getText().length)
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(s.document.uri, full, s.originalContent);
    await vscode.workspace.applyEdit(edit);
    await this.teardown();
    void vscode.window.showInformationMessage(
      message ?? 'CopyWorkCode: review stopped. Content restored; debt unchanged.'
    );
  }

  private async finish(): Promise<void> {
    const s = this.session;
    if (!s) return;
    this.session = undefined;
    await s.document.save();
    advanceBaseline(s.root, s.file, s.document.getText());
    this.log.add({
      file: s.file,
      at: new Date().toISOString(),
      outcome: s.hunksTyped > 0 ? 'typed' : 'skipped',
      hunksTyped: s.hunksTyped,
      hunksSkipped: s.hunksSkipped,
    });
    await this.teardown();
    void vscode.window.showInformationMessage(
      `CopyWorkCode: review complete — ${s.hunksTyped} section(s) typed, ${s.hunksSkipped} skipped.`
    );
  }

  private async teardown(): Promise<void> {
    this.typeOverride?.dispose();
    this.typeOverride = undefined;
    this.statusBar.hide();
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.ghost, []);
    }
    await vscode.commands.executeCommand('setContext', 'copyworkcode.reviewing', false);
    this.emitter.fire();
  }

  private async applyChange(
    build: (edit: vscode.WorkspaceEdit) => void
  ): Promise<void> {
    const s = this.session;
    if (!s) return;
    const edit = new vscode.WorkspaceEdit();
    build(edit);
    s.applying = true;
    try {
      await vscode.workspace.applyEdit(edit);
    } finally {
      s.applying = false;
    }
  }

  private editorFor(document: vscode.TextDocument): vscode.TextEditor | undefined {
    return vscode.window.visibleTextEditors.find((e) => e.document === document);
  }

  private insertPosition(): vscode.Position | undefined {
    const s = this.session;
    if (!s) return undefined;
    const task = s.tasks[s.index];
    return s.document.positionAt(task.startOffset + s.engine.position);
  }

  private moveCursor(): void {
    const s = this.session;
    const at = this.insertPosition();
    if (!s || !at) return;
    const editor = this.editorFor(s.document);
    if (!editor) return;
    editor.selection = new vscode.Selection(at, at);
    editor.revealRange(
      new vscode.Range(at, at),
      vscode.TextEditorRevealType.InCenterIfOutsideViewport
    );
  }

  private updateUi(mismatch = false): void {
    const s = this.session;
    const at = this.insertPosition();
    if (!s || !at) return;

    const editor = this.editorFor(s.document);
    if (editor) {
      const remaining = s.engine.remaining;
      const lineRest = remaining.split('\n', 1)[0].replace(/\r/g, '');
      const preview =
        lineRest.length > 0 ? lineRest : remaining.length > 0 ? '⏎' : '';
      editor.setDecorations(this.ghost, [
        {
          range: new vscode.Range(at, at),
          renderOptions: { after: { contentText: preview } },
        },
      ]);
    }

    const flag = mismatch ? '$(error) wrong key — ' : '$(keyboard) ';
    this.statusBar.text =
      `${flag}Retype ${s.index + 1}/${s.tasks.length}: ` +
      'Alt+F fill line · Alt+S skip section · Shift+Esc stop';
    this.statusBar.show();
  }

  dispose(): void {
    this.changeGuard.dispose();
    this.typeOverride?.dispose();
    this.ghost.dispose();
    this.statusBar.dispose();
    this.emitter.dispose();
  }
}
