import * as fs from 'fs';
import * as vscode from 'vscode';
import { ChangeEvent } from './types';
import { EventQueue } from './eventQueue';
import { ReviewLog } from './reviewState';
import { DebtMode, DebtSource } from './debtSource';
import { DebtDecorations, DebtTreeProvider } from './debtView';
import { RetypeController, BASELINE_SCHEME, REMOVED_SCHEME } from './retypeController';
import { syncCaptureHook } from './hookInstaller';
import { matchesAny } from './core/glob';
import { advanceBaseline, readBaseline } from './core/baselineStore';
import { hasDebt } from './core/diff';
import * as workspaceData from './workspaceData';

let queue: EventQueue | undefined;
let log: ReviewLog | undefined;
let source: DebtSource | undefined;
let tree: DebtTreeProvider | undefined;
let retype: RetypeController | undefined;

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(BASELINE_SCHEME, {
      provideTextDocumentContent: (uri) => source?.baselineFor(uri.query) ?? '',
    }),

    // Lines a change deleted, given a document of their own so a panel can show
    // them: the buffer they came from has no room for text that is not there.
    vscode.workspace.registerTextDocumentContentProvider(REMOVED_SCHEME, {
      provideTextDocumentContent: (uri) => retype?.removedTextFor(uri) ?? '',
    }),

    vscode.commands.registerCommand('copyworkcode.enableWorkspace', () => {
      const root = workspaceData.workspaceRoot();
      if (!root) {
        void vscode.window.showErrorMessage('CopyWorkCode: open a folder first.');
        return;
      }
      workspaceData.enableWorkspace(root);
      startTracking(root, context);
    }),

    vscode.commands.registerCommand('copyworkcode.installAgentHook', () =>
      setAgentCapture(true)
    ),
    vscode.commands.registerCommand('copyworkcode.uninstallAgentHook', () =>
      setAgentCapture(false)
    ),

    vscode.commands.registerCommand('copyworkcode.reviewFile', (file: string) => {
      const root = workspaceData.workspaceRoot();
      if (root && retype) return retype.start(root, file);
    }),

    vscode.commands.registerCommand('copyworkcode.skipFile', (item?: { resourceUri?: vscode.Uri }) => {
      const file = item?.resourceUri?.fsPath;
      const root = workspaceData.workspaceRoot();
      if (!file || !root || !source) return;
      // Skipping from the view acknowledges what the view is showing, so it
      // clears the debt against whichever baseline the rows were built from.
      skipWithoutTyping(root, file, 'skipped', source.baselineFor(file));
      tree?.refresh();
    }),

    vscode.commands.registerCommand('copyworkcode.useGitBaseline', () =>
      setDebtMode('git')
    ),
    vscode.commands.registerCommand('copyworkcode.useTrackedBaseline', () =>
      setDebtMode('tracked')
    ),
    vscode.commands.registerCommand('copyworkcode.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'copyworkcode')
    ),

    vscode.commands.registerCommand('copyworkcode.refresh', () => tree?.refresh()),
    vscode.commands.registerCommand('copyworkcode.skipSection', () => retype?.skipSection()),
    vscode.commands.registerCommand('copyworkcode.fillNextLine', () => retype?.fillNextLine()),
    vscode.commands.registerCommand('copyworkcode.fillNextWord', () => retype?.fillNextWord()),
    vscode.commands.registerCommand('copyworkcode.peekRemoved', (start: number) =>
      retype?.peekRemoved(start)
    ),
    vscode.commands.registerCommand('copyworkcode.abortReview', () => retype?.abort()),
    vscode.commands.registerCommand('copyworkcode.finishReview', () =>
      retype?.finishReview()
    ),
    vscode.commands.registerCommand('copyworkcode.typeEnter', () => retype?.typeEnter()),
    vscode.commands.registerCommand('copyworkcode.enableEditing', () =>
      retype?.enableEditing()
    ),
    vscode.commands.registerCommand('copyworkcode.resumeTyping', () =>
      retype?.resumeTyping()
    ),
    vscode.commands.registerCommand('copyworkcode.focusSection', (offset: number) =>
      retype?.focusSection(offset)
    ),
    vscode.commands.registerCommand('copyworkcode.reviewNextFile', () => {
      const root = workspaceData.workspaceRoot();
      if (root && retype) return retype.reviewNextFile(root);
    }),
    vscode.commands.registerCommand('copyworkcode.confirmSection', () =>
      retype?.confirmSection()
    ),
    vscode.commands.registerCommand('copyworkcode.jumpToReview', () =>
      retype?.jumpToCurrent()
    ),
    vscode.commands.registerCommand('copyworkcode.showReviewDiff', () =>
      retype?.showDiff()
    ),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`copyworkcode.${CAPTURE_SETTING}`)) {
        void applyAgentCapture(context);
      }
    })
  );

  const root = workspaceData.workspaceRoot();
  if (root && workspaceData.isEnabled(root)) {
    startTracking(root, context);
  }

  // Capture is application-scoped, so it is reconciled whether or not this
  // particular folder is enabled.
  void applyAgentCapture(context);
}

const CAPTURE_SETTING = 'agentCapture';

/**
 * Record the user's choice; the configuration listener below is what acts on
 * it. Routing both commands through the setting keeps one source of truth, so
 * the toggle in Settings and the palette commands can never disagree about
 * whether capture is on.
 */
async function setAgentCapture(enabled: boolean): Promise<void> {
  await vscode.workspace
    .getConfiguration('copyworkcode')
    .update(CAPTURE_SETTING, enabled, vscode.ConfigurationTarget.Global);
}

function captureWanted(): boolean {
  return vscode.workspace
    .getConfiguration('copyworkcode')
    .get<boolean>(CAPTURE_SETTING, false);
}

/**
 * Make the installed hook match the setting. Runs on activation as well as on
 * every change, so the setting stays the thing that decides: a machine that
 * received the preference through settings sync installs the hook on its own,
 * and a hook removed by hand outside the editor comes back only because the
 * setting still asks for it.
 *
 * Silent when there was nothing to do — which is the default case, capture
 * being off — so activation never announces itself.
 */
async function applyAgentCapture(context: vscode.ExtensionContext): Promise<void> {
  const wanted = captureWanted();
  const result = await syncCaptureHook(context, wanted);
  if (result === 'unchanged' || result === 'failed') return;

  const messages = {
    installed:
      'CopyWorkCode: agent capture on. Sessions started from now on will record their edits.',
    repointed: 'CopyWorkCode: agent capture hook updated to this version.',
    removed:
      'CopyWorkCode: agent capture off, hook removed. Review history stays in .copyworkcode/.',
  } as const;
  void vscode.window.showInformationMessage(messages[result]);
}

/**
 * Switch what the review queue compares against. Git mode is verified before
 * it is entered — a folder with no repository, or a revision that doesn't
 * exist, would otherwise show an empty queue that looks like "all clear".
 */
async function setDebtMode(mode: DebtMode): Promise<void> {
  if (!source) return;
  if (mode === 'git' && !source.gitAvailable()) {
    void vscode.window.showWarningMessage(
      `CopyWorkCode: cannot read git changes here — no git repository, or no such revision (${source.ref}).`
    );
    return;
  }
  await source.setMode(mode);
}

function startTracking(root: string, context: vscode.ExtensionContext): void {
  if (queue) return; // already tracking this window
  void vscode.commands.executeCommand('setContext', 'copyworkcode.enabled', true);

  queue = new EventQueue(root);
  log = new ReviewLog(root);
  source = new DebtSource(root, context.workspaceState);
  retype = new RetypeController(log, source);
  const decorations = new DebtDecorations();
  tree = new DebtTreeProvider(
    root,
    source,
    queue,
    log,
    (file) => retype?.progressFor(file),
    decorations
  );
  const view = vscode.window.createTreeView('copyworkcode.debt', {
    treeDataProvider: tree,
  });
  tree.attach(view);

  context.subscriptions.push(
    queue,
    log,
    source,
    retype,
    decorations,
    view,
    vscode.window.registerFileDecorationProvider(decorations),
    queue.onDidAddEvents((events) => {
      autoSkip(root, events);
      tree?.refresh();
    }),
    log.onDidChange(() => tree?.refresh()),
    source.onDidChangeMode(() => tree?.refresh()),
    retype.onDidFinish(() => tree?.refresh()),
    vscode.workspace.onDidSaveTextDocument(() => tree?.refresh()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('copyworkcode.gitRef')) tree?.refresh();
    })
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
    // Capture-driven, so it always works off the tracked snapshot: what the
    // view happens to be comparing against right now is beside the point.
    skipWithoutTyping(root, event.file, 'auto-skipped', readBaseline(root, event.file));
  }
}

/** Advance the baseline to the current content without a retype pass. */
function skipWithoutTyping(
  root: string,
  file: string,
  outcome: 'skipped' | 'auto-skipped',
  baseline: string | undefined
): void {
  if (baseline === undefined) return;
  let current = '';
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch {
    // File deleted: advancing to empty acknowledges the deletion.
  }
  if (!hasDebt(baseline, current)) return; // nothing pending, nothing to log
  // The debt is about to be cleared, so any review of this file is moot.
  void retype?.forget(file);
  advanceBaseline(root, file, current);
  log?.add({ file, at: new Date().toISOString(), outcome });
}

export function deactivate(): void {
  queue = undefined;
  log = undefined;
  source = undefined;
  tree = undefined;
  retype = undefined;
}
