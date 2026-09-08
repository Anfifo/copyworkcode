import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChangeEvent } from './types';
import { EventQueue } from './eventQueue';
import { ReviewLog } from './reviewState';
import { ChangeSetPanel } from './changeSetPanel';
import { DebtMode, DebtSource, forgetDebtChoices } from './debtSource';
import { DebtDecorations, DebtTreeProvider, RowProgress } from './debtView';
import { RetypeController, BASELINE_SCHEME, REMOVED_SCHEME } from './retypeController';
import { HookReport, inspectCaptureHook, syncCaptureHook } from './hookInstaller';
import { matchesAny } from './core/glob';
import { advanceBaseline, readBaseline } from './core/baselineStore';
import { hasDebt } from './core/diff';
import * as workspaceData from './workspaceData';
import { dataHome } from './core/dataHome';
import { IGNORE_FILE, appendIgnore, ignoreFilePath, suggestPatterns } from './core/ignoreFile';

let queue: EventQueue | undefined;
let log: ReviewLog | undefined;
let source: DebtSource | undefined;
let tree: DebtTreeProvider | undefined;
let retype: RetypeController | undefined;
let changeSet: ChangeSetPanel | undefined;
/** Everything startTracking created, so it can be undone as one. */
let tracking: vscode.Disposable | undefined;

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

    vscode.commands.registerCommand('copyworkcode.forgetWorkspace', () =>
      forgetWorkspaceData()
    ),
    vscode.commands.registerCommand('copyworkcode.resetEverything', () =>
      resetEverything(context)
    ),
    vscode.commands.registerCommand('copyworkcode.checkAgentHook', () =>
      checkAgentHook(context)
    ),
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

    vscode.commands.registerCommand('copyworkcode.openChangeSet', () =>
      changeSet?.show()
    ),

    // The same key the editor review takes the pen with, on the other surface.
    // Which region it means is the page's to answer, so the command only asks.
    vscode.commands.registerCommand('copyworkcode.editOnPage', () =>
      changeSet?.editOnPage()
    ),

    // Both row commands arrive with the tree's element, which is the file path
    // the item was built from, and from the right-click menu with the rows
    // selected alongside it.
    vscode.commands.registerCommand(
      'copyworkcode.skipFile',
      (file?: string, selection?: string[]) => {
        const root = workspaceData.workspaceRoot();
        if (!root || !source) return;
        // Skipping from the view acknowledges what the view is showing, so it
        // clears the debt against whichever baseline the rows were built from.
        for (const target of rowTargets(file, selection)) {
          skipWithoutTyping(root, target, 'skipped', source.baselineFor(target));
        }
        tree?.refresh();
      }
    ),

    vscode.commands.registerCommand('copyworkcode.resetReview', (file?: string) =>
      retype?.resetReview(file)
    ),
    vscode.commands.registerCommand(
      'copyworkcode.ignoreFile',
      (file?: string, selection?: string[]) => ignoreFiles(rowTargets(file, selection))
    ),
    vscode.commands.registerCommand('copyworkcode.openIgnoreFile', () => openIgnoreFile()),

    vscode.commands.registerCommand('copyworkcode.useGitBaseline', () =>
      setDebtMode('git')
    ),
    vscode.commands.registerCommand('copyworkcode.useTrackedBaseline', () =>
      setDebtMode('tracked')
    ),
    vscode.commands.registerCommand('copyworkcode.pickGitRevision', () =>
      pickGitRevision()
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
    vscode.commands.registerCommand('copyworkcode.pauseReview', () => retype?.pause()),
    vscode.commands.registerCommand('copyworkcode.finishReview', () =>
      retype?.finishReview()
    ),
    vscode.commands.registerCommand('copyworkcode.typeEnter', () => retype?.typeEnter()),
    vscode.commands.registerCommand('copyworkcode.typeBackspace', () =>
      retype?.typeBackspace()
    ),
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
function applyAgentCapture(context: vscode.ExtensionContext): void {
  const wanted = captureWanted();
  const result = syncCaptureHook(context, wanted);
  if (result === 'unchanged' || result === 'failed') return;

  const messages = {
    installed:
      'CopyWorkCode: agent capture on. Sessions started from now on will record their edits.',
    repointed: 'CopyWorkCode: agent capture hook updated to this version.',
    removed: `CopyWorkCode: agent capture off, hook removed. Review history stays under ${dataHome()}.`,
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

const COMMITS_OFFERED = 40;

/**
 * Keep queued files out of every future queue. One file is the seed for a
 * choice of how wide the line is; several are each ignored by their own path,
 * since a selection has no folder or extension in common to offer.
 */
async function ignoreFiles(files: string[]): Promise<void> {
  const root = workspaceData.workspaceRoot();
  if (files.length === 0 || !root) return;
  if (files.length === 1) {
    await ignoreOne(root, files[0]);
    return;
  }
  for (const file of files) {
    const [own] = suggestPatterns(path.relative(root, file));
    appendIgnore(root, own);
    void retype?.forget(file, `${path.basename(file)} is ignored now; its review ended.`);
  }
  tree?.refresh();
  void vscode.window.setStatusBarMessage(
    `CopyWorkCode: ${files.length} files added to ${IGNORE_FILE}.`,
    5000
  );
}

/**
 * The reviewer picks how wide the line is: this file, its folder, or its
 * extension anywhere. The line goes into the ignore file at the workspace
 * root, which is created by the first one.
 */
async function ignoreOne(root: string, file: string): Promise<void> {
  const rel = path.relative(root, file);
  const [own, folder, extension] = suggestPatterns(rel);
  const items: vscode.QuickPickItem[] = [{ label: own, description: 'this file' }];
  if (folder) items.push({ label: folder, description: 'everything in this folder' });
  if (extension) items.push({ label: extension, description: 'files with this extension, anywhere' });
  const pick = await vscode.window.showQuickPick(items, {
    title: `Ignore in reviews — written to ${IGNORE_FILE}`,
    placeHolder: 'Matching files leave the queue and are not offered again.',
  });
  if (!pick) return;
  appendIgnore(root, pick.label);
  void retype?.forget(file, `${path.basename(file)} is ignored now; its review ended.`);
  tree?.refresh();
  void vscode.window.setStatusBarMessage(
    `CopyWorkCode: ${pick.label} added to ${IGNORE_FILE}.`,
    5000
  );
}

/**
 * Open the ignore file to edit it by hand. It does not exist until something
 * has been ignored, so with no file yet the reviewer is asked before one is
 * made for them.
 */
async function openIgnoreFile(): Promise<void> {
  const root = workspaceData.workspaceRoot();
  if (!root) return;
  const file = ignoreFilePath(root);
  if (!fs.existsSync(file)) {
    const choice = await vscode.window.showInformationMessage(
      `CopyWorkCode: this workspace has no ${IGNORE_FILE} yet. Right-click a file in the queue to ignore it, or create the file now.`,
      'Create'
    );
    if (choice !== 'Create') return;
    fs.writeFileSync(
      file,
      '# Files CopyWorkCode never queues for review. One pattern per line, like a .gitignore.\n'
    );
  }
  await vscode.window.showTextDocument(vscode.Uri.file(file));
}

/**
 * Choose the revision git mode compares against: one of the recent commits, a
 * revision typed by hand, or the setting again. Picking one enters git mode,
 * since a commit is only ever picked to be compared against.
 */
async function pickGitRevision(): Promise<void> {
  if (!source) return;
  const commits = source.recentCommits(COMMITS_OFFERED);
  if (!commits) {
    void vscode.window.showWarningMessage(
      'CopyWorkCode: cannot list commits here — no git repository, or no commits yet.'
    );
    return;
  }
  const TYPE = 'Type a revision…';
  const BACK = `Back to ${source.configuredRef}`;
  const items: vscode.QuickPickItem[] = commits.map((c) => ({
    label: c.short,
    description: c.subject,
    detail: c.when,
  }));
  if (source.pickedRef !== undefined) {
    items.unshift({ label: BACK, description: 'the revision from settings' });
  }
  items.push({ label: TYPE, description: 'a tag, a branch, or any revision git understands' });

  const pick = await vscode.window.showQuickPick(items, {
    title: 'Compare against a commit',
    placeHolder: `Comparing against ${source.ref}. Pick the revision the working tree is compared to.`,
    matchOnDescription: true,
  });
  if (!pick) return;

  let ref: string | undefined = pick.label;
  if (pick.label === BACK) ref = undefined;
  if (pick.label === TYPE) {
    ref = await vscode.window.showInputBox({
      prompt: 'Revision to compare against',
      placeHolder: 'v1.2.0, main, HEAD~3, or a commit hash',
      validateInput: (value) =>
        value.trim().length === 0
          ? 'Enter a revision.'
          : source?.revisionExists(value.trim())
            ? undefined
            : `git cannot resolve ${value.trim()} here.`,
    });
    if (ref === undefined) return;
    ref = ref.trim();
  }
  await source.setRef(ref);
  await setDebtMode('git');
}

/**
 * What the queue row says about a file, from whichever surface holds it. The
 * editor review answers first, and not only for tidiness: starting one there
 * takes the file off the page, so a file both could claim is the editor's by
 * the time this is asked.
 *
 * Each surface reports coverage in its own terms and neither knows about the
 * other; naming the one to go back to is the row's business, and so it is done
 * here.
 */
function rowProgress(file: string): RowProgress | undefined {
  const editor = retype?.progressFor(file);
  if (editor) {
    return {
      claimed: editor.claimed,
      total: editor.total,
      state: editor.paused ? 'paused' : 'reviewing',
    };
  }
  const page = changeSet?.progressFor(file);
  return page ? { claimed: page.claimed, total: page.total, state: 'page' } : undefined;
}

/**
 * Delete the workspace's review data and stop tracking it. Modal, because it
 * is the one destructive command: baselines, captured events and the review
 * log go together, and there is no undo. The workspace can be enabled again
 * afterwards, starting from nothing.
 */
async function forgetWorkspaceData(): Promise<void> {
  const root = workspaceData.workspaceRoot();
  if (!root || !workspaceData.isEnabled(root)) return;
  const choice = await vscode.window.showWarningMessage(
    'CopyWorkCode: delete all review data for this workspace? Baselines, captured events and the review log are removed. This cannot be undone.',
    { modal: true },
    'Delete'
  );
  if (choice !== 'Delete') return;
  stopTracking();
  workspaceData.disableWorkspace(root);
  void vscode.window.showInformationMessage(
    'CopyWorkCode: review data for this workspace deleted.'
  );
}

/** Every setting the extension contributes, as written in package.json. */
const SETTINGS = ['autoSkipGlobs', 'animations', 'gitRef', CAPTURE_SETTING, 'startEditing'];

/**
 * Back to the fresh install: the workspace's review data, the remembered
 * compare mode, every setting at both scopes, and with the capture setting the
 * hook. The one confirmation lists all of it, since the settings reach every
 * workspace and there is no undo. What is left is the enable welcome.
 */
async function resetEverything(context: vscode.ExtensionContext): Promise<void> {
  const root = workspaceData.workspaceRoot();
  const enabled = root !== undefined && workspaceData.isEnabled(root);
  const choice = await vscode.window.showWarningMessage(
    'CopyWorkCode: reset everything?',
    {
      modal: true,
      detail: [
        enabled
          ? 'Review data for this workspace is deleted: baselines, captured events and the review log.'
          : 'This workspace has no review data to delete.',
        'Agent capture is turned off and the hook is removed from the agent settings.',
        'Every CopyWorkCode setting goes back to its default, in user and workspace settings.',
        'This cannot be undone.',
      ].join('\n'),
    },
    'Reset'
  );
  if (choice !== 'Reset') return;

  stopTracking();
  if (root && enabled) workspaceData.disableWorkspace(root);
  await forgetDebtChoices(context.workspaceState);
  const config = vscode.workspace.getConfiguration('copyworkcode');
  for (const key of SETTINGS) {
    await config.update(key, undefined, vscode.ConfigurationTarget.Global);
    // The capture setting is application-scoped and has no workspace value.
    if (root && key !== CAPTURE_SETTING) {
      await config.update(key, undefined, vscode.ConfigurationTarget.Workspace);
    }
  }
  // The setting's listener removes the hook when the setting changed. A hook
  // left behind with the setting already off is reconciled here.
  applyAgentCapture(context);
  void vscode.window.showInformationMessage(
    'CopyWorkCode: reset. Run Enable in this Workspace to start again.'
  );
}

/**
 * Show what the agent settings file says about the hook next to what the
 * setting asks for, and offer the way to make them agree. Every button goes
 * through the setting, or re-runs the reconcile the setting drives, so the
 * dialog can never leave the two disagreeing.
 */
async function checkAgentHook(context: vscode.ExtensionContext): Promise<void> {
  const report = inspectCaptureHook(context);
  const wanted = captureWanted();
  const present = report.events.length > 0;
  const current = report.command === report.expected;

  const buttons: string[] = [];
  if (wanted && !(present && current) && report.fileState !== 'unreadable') {
    buttons.push('Repair Hook');
  }
  if (!wanted && present) buttons.push('Remove Hook');
  buttons.push(wanted ? 'Turn Off Capture' : 'Turn On Capture');
  if (report.fileState !== 'missing') buttons.push('Open Settings File');

  const choice = await vscode.window.showInformationMessage(
    'CopyWorkCode: agent hook configuration',
    { modal: true, detail: describeReport(report, wanted) },
    ...buttons
  );
  switch (choice) {
    case 'Repair Hook':
    case 'Remove Hook':
      applyAgentCapture(context);
      return;
    case 'Turn On Capture':
      return setAgentCapture(true);
    case 'Turn Off Capture':
      return setAgentCapture(false);
    case 'Open Settings File':
      await vscode.window.showTextDocument(vscode.Uri.file(report.file));
      return;
  }
}

function describeReport(report: HookReport, wanted: boolean): string {
  const present = report.events.length > 0;
  const current = report.command === report.expected;
  const lines = [
    `Settings file: ${report.file}`,
    {
      found: 'File: found.',
      missing: 'File: not found, so nothing is installed.',
      unreadable: 'File: found but not valid JSON, so the hook cannot be read or written.',
    }[report.fileState],
    present ? `Hook: present on ${report.events.join(', ')}.` : 'Hook: not installed.',
  ];
  if (present) {
    lines.push(
      current ? 'Command: runs this install.' : `Command: runs another install. ${report.command}`
    );
  }
  lines.push(`Agent capture setting: ${wanted ? 'on' : 'off'}.`, '');
  if (wanted && present && current) {
    lines.push('Capture is on and the hook matches this install.');
  } else if (wanted && present) {
    lines.push('Capture is on but the hook runs an older copy. Repair points it at this install.');
  } else if (wanted) {
    lines.push('Capture is on but the hook is missing. Repair installs it.');
  } else if (present) {
    lines.push('Capture is off but the hook is still installed. Remove takes it out.');
  } else {
    lines.push('Capture is off and nothing is installed.');
  }
  return lines.join('\n');
}

function startTracking(root: string, context: vscode.ExtensionContext): void {
  if (tracking) return; // already tracking this window
  void vscode.commands.executeCommand('setContext', 'copyworkcode.enabled', true);

  queue = new EventQueue(root);
  log = new ReviewLog(root);
  source = new DebtSource(root, context.workspaceState);
  retype = new RetypeController(log, source);
  changeSet = new ChangeSetPanel(
    context.extensionUri,
    root,
    source,
    log,
    (file) =>
      // The page is about to review this file itself, and one surface owns a
      // file at a time — see changeSetPanel.ts.
      retype?.forget(
        file,
        `review of ${path.basename(file)} ended — the change set page took it over.`
      ) ?? Promise.resolve(),
    // The other direction: the page is giving a file up so the reviewer can
    // write their own code in it, and what it covered goes along.
    (file, handover) => retype?.adopt(root, file, handover) ?? Promise.resolve(false)
  );
  const decorations = new DebtDecorations(
    (file) => retype?.progressFor(file)?.paused === false
  );
  tree = new DebtTreeProvider(root, source, queue, log, rowProgress, decorations);
  // Edits to the ignore file from outside the editor still reach the queue.
  const ignoreWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(root, IGNORE_FILE)
  );
  const view = vscode.window.createTreeView('copyworkcode.debt', {
    treeDataProvider: tree,
    // The right-click menu acts on every selected row, so a queue can be
    // cleared or narrowed in one pass.
    canSelectMany: true,
  });
  tree.attach(view);

  tracking = vscode.Disposable.from(
    queue,
    log,
    source,
    retype,
    changeSet,
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
    // The page's own coverage is on its rows now, so this carries a region
    // closing there as well as a file finishing.
    changeSet.onDidFinish(() => tree?.refresh()),
    // Starting or resuming a review moves no baseline, but the row it belongs to
    // has to pick up its tint and its "reviewing N/M" description, and whichever
    // row was paused in its place has to give the tint back. It is also where the
    // change set page lets go of that one file.
    retype.onDidStart((file) => {
      tree?.refresh();
      changeSet?.dropFile(file);
    }),
    vscode.workspace.onDidSaveTextDocument(() => tree?.refresh()),
    ignoreWatcher,
    ignoreWatcher.onDidCreate(() => tree?.refresh()),
    ignoreWatcher.onDidChange(() => tree?.refresh()),
    ignoreWatcher.onDidDelete(() => tree?.refresh()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('copyworkcode.gitRef')) tree?.refresh();
    })
  );
  context.subscriptions.push({ dispose: () => stopTracking() });

  queue.start();
  tree.refresh();
}

/** Undo startTracking: dispose every tracker and clear the enabled context. */
function stopTracking(): void {
  if (!tracking) return;
  tracking.dispose();
  tracking = undefined;
  queue = log = source = tree = retype = changeSet = undefined;
  void vscode.commands.executeCommand('setContext', 'copyworkcode.enabled', false);
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
    // view happens to be comparing against right now does not enter into it.
    skipWithoutTyping(root, event.file, 'auto-skipped', readBaseline(root, event.file));
  }
}

/**
 * The rows a menu command acts on. The right-click menu passes the clicked row
 * and the selection it belongs to; the inline buttons pass the row alone.
 */
function rowTargets(file?: string, selection?: string[]): string[] {
  if (selection && selection.length > 0) return selection;
  return file ? [file] : [];
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
  changeSet = undefined;
}
