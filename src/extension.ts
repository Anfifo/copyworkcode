import * as path from 'path';
import * as vscode from 'vscode';
import { ChangeEvent } from './types';
import { EventQueue } from './eventQueue';
import { ReviewState } from './reviewState';
import { UnreviewedTreeProvider } from './unreviewedView';
import { installClaudeCodeHook } from './hookInstaller';
import { matchesAny } from './glob';
import * as workspaceData from './workspaceData';

const BASE_SCHEME = 'copyworkcode-base';

let queue: EventQueue | undefined;
let state: ReviewState | undefined;
let tree: UnreviewedTreeProvider | undefined;

/** Pre-change file snapshots served to the diff view, keyed by event id. */
const baseContents = new Map<string, string>();

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, {
      provideTextDocumentContent: (uri) =>
        baseContents.get(uri.path.split('/')[1]) ?? '',
    }),

    vscode.commands.registerCommand('copyworkcode.enableWorkspace', async () => {
      const root = workspaceData.workspaceRoot();
      if (!root) {
        void vscode.window.showErrorMessage(
          'CopyWorkCode: open a folder first.'
        );
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

    vscode.commands.registerCommand(
      'copyworkcode.reviewChange',
      (event: ChangeEvent) => reviewChange(event)
    ),

    vscode.commands.registerCommand(
      'copyworkcode.skipChange',
      (event: ChangeEvent) => state?.setStatus(event.id, 'skipped')
    )
  );

  const root = workspaceData.workspaceRoot();
  if (root && workspaceData.isEnabled(root)) {
    startTracking(root, context);
  }
}

function startTracking(root: string, context: vscode.ExtensionContext): void {
  if (queue) return; // already tracking this window

  queue = new EventQueue(root);
  state = new ReviewState(root);
  tree = new UnreviewedTreeProvider(root, queue, state);

  context.subscriptions.push(
    queue,
    state,
    vscode.window.registerTreeDataProvider('copyworkcode.unreviewed', tree),
    queue.onDidAddEvents((events) => {
      autoSkip(events);
      tree?.refresh();
    }),
    state.onDidChange(() => tree?.refresh())
  );

  queue.start();
  tree.refresh();
}

function autoSkip(events: ChangeEvent[]): void {
  const globs = vscode.workspace
    .getConfiguration('copyworkcode')
    .get<string[]>('autoSkipGlobs', []);
  if (globs.length === 0) return;
  for (const event of events) {
    if (matchesAny(event.file, globs)) {
      state?.setStatus(event.id, 'auto-skipped');
    }
  }
}

async function reviewChange(event: ChangeEvent): Promise<void> {
  const fileUri = vscode.Uri.file(event.file);

  if (event.change?.kind === 'edit' && event.change.baseContent !== undefined) {
    baseContents.set(event.id, event.change.baseContent);
    const baseUri = vscode.Uri.from({
      scheme: BASE_SCHEME,
      path: `/${event.id}/${path.basename(event.file)}`,
    });
    await vscode.commands.executeCommand(
      'vscode.diff',
      baseUri,
      fileUri,
      `${path.basename(event.file)} (before change ↔ current)`
    );
  } else {
    await vscode.window.showTextDocument(fileUri, { preview: true });
  }

  // Placeholder until the guided retype flow exists: reviewing currently means
  // reading the diff and confirming explicitly.
  const action = await vscode.window.showInformationMessage(
    'Guided retype is not implemented yet. Mark this change after reading it.',
    'Mark Reviewed',
    'Skip'
  );
  if (action === 'Mark Reviewed') {
    state?.setStatus(event.id, 'reviewed');
  } else if (action === 'Skip') {
    state?.setStatus(event.id, 'skipped');
  }
}

export function deactivate(): void {
  queue = undefined;
  state = undefined;
  tree = undefined;
}
