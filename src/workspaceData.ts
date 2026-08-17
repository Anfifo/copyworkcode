import * as fs from 'fs';
import * as vscode from 'vscode';
import { DATA_DIR, dataDir } from './core/paths';
import { ensureLocalGitExclude } from './core/gitExclude';

/** Root folder of the workspace the extension operates on, if any. */
export function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** A workspace is enabled once its data directory exists. */
export function isEnabled(root: string): boolean {
  return fs.existsSync(dataDir(root));
}

/**
 * Create the data directory and keep it out of git via the repo-local
 * exclude list — invisible to `git status` and to collaborators, with no
 * change to the project's `.gitignore` and nothing to ask the user.
 */
export function enableWorkspace(root: string): void {
  fs.mkdirSync(dataDir(root), { recursive: true });
  ensureLocalGitExclude(root, `${DATA_DIR}/`);
}
