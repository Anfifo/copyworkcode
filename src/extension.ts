import * as fs from 'fs';
import * as vscode from 'vscode';
import { ChangeEvent } from './types';
import { EventQueue } from './eventQueue';
import { ReviewLog } from './reviewState';
import { DebtTreeProvider } from './debtView';
import { RetypeController, BASELINE_SCHEME } from './retypeController';
import { installClaudeCodeHook } from './hookInstaller';
import { matchesAny } from './core/glob';
import { advanceBaseline, readBaseline } from './core/baselineStore';
import { hasDebt } from './core/diff';
import * as workspaceData from './workspaceData';

let queue: EventQueue | undefined;
let log: ReviewLog | undefined;
let tree: DebtTreeProvider | undefined;
let retype: RetypeController | undefined;

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(BASELINE_SCHEME, {
      provideTextDocumentContent: (uri) => {
        const root = workspaceData.workspaceRoot();
        return root ? readBaseline(root, uri.query) ?? '' : '';
      },
    }),

    vscode.commands.registerCommand('copyworkcode.enableWorkspace', async () => {
      const root = workspaceData.workspaceRoot();
      if (!root) {
        void vscode.window.showErrorMessage('CopyWorkCode: open a folder first.');
        return;
      }
      await workspaceData.enableWorkspace(root);
      startTracking(root, context);
      const install = await vscode.window.showInformationMessage(
        'CopyWorkCode enabled. Install the agent capture hook now? (One-time, user-wide.)',
        'Install',
        'Later'
      );
      if (install === 'Install') {
        await installClaudeCodeHook(context);
      }
    }),

    vscode.commands.registerCommand('copyworkcode.installAgentHook', () =>
      installClaudeCodeHook(context)
    ),

    vscode.commands.registerCommand('copyworkcode.reviewFile', (file: string) => {
      const root = workspaceData.workspaceRoot();
      if (root && retype) return retype.start(root, file);
    }),

    vscode.commands.registerCommand('copyworkcode.skipFile', (item?: { resourceUri?: vscode.Uri }) => {
      const file = item?.resourceUri?.fsPath;
      const root = workspaceData.workspaceRoot();
      if (!file || !root) return;
      skipWithoutTyping(root, file, 'skipped');
      tree?.refresh();
    }),

    vscode.commands.registerCommand('copyworkcode.refresh', () => tree?.refresh()),
    vscode.commands.registerCommand('copyworkcode.skipSection', () => retype?.skipSection()),
    vscode.commands.registerCommand('copyworkcode.fillNextLine', () => retype?.fillNextLine()),
    vscode.commands.registerCommand('copyworkcode.abortReview', () => retype?.abort())
  );

  const root = workspaceData.workspaceRoot();
  if (root && workspaceData.isEnabled(root)) {
    startTracking(root, context);
  }
}

function startTracking(root: string, context: vscode.ExtensionContext): void {
  if (queue) return; // already tracking this window
  void vscode.commands.executeCommand('setContext', 'copyworkcode.enabled', true);

  queue = new EventQueue(root);
  log = new ReviewLog(root);
  retype = new RetypeController(log);
  tree = new DebtTreeProvider(root, queue, log);

  context.subscriptions.push(
    queue,
    log,
    retype,
    vscode.window.registerTreeDataProvider('copyworkcode.debt', tree),
    queue.onDidAddEvents((events) => {
      autoSkip(root, events);
      tree?.refresh();
    }),
    log.onDidChange(() => tree?.refresh()),
    retype.onDidFinish(() => tree?.refresh()),
    vscode.workspace.onDidSaveTextDocument(() => tree?.refresh())
  );

  queue.start();
  tree.refresh();
}

function autoSkip(root: string, events: ChangeEvent[]): void {
  const globs = vscode.workspace
    .getConfiguration('copyworkcode')
    .get<string[]>('autoSkipGlobs', []);
  if (globs.length === 0) return;
  const done = new Set<string>();
  for (const event of events) {
    if (done.has(event.file) || !matchesAny(event.file, globs)) continue;
    done.add(event.file);
    skipWithoutTyping(root, event.file, 'auto-skipped');
  }
}

/** Advance the baseline to the current content without a retype pass. */
function skipWithoutTyping(
  root: string,
  file: string,
  outcome: 'skipped' | 'auto-skipped'
): void {
  const baseline = readBaseline(root, file);
  if (baseline === undefined) return;
  let current = '';
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch {
    // File deleted: advancing to empty acknowledges the deletion.
  }
  if (!hasDebt(baseline, current)) return; // nothing pending, nothing to log
  advanceBaseline(root, file, current);
  log?.add({ file, at: new Date().toISOString(), outcome });
}

export function deactivate(): void {
  queue = undefined;
  log = undefined;
  tree = undefined;
  retype = undefined;
}
