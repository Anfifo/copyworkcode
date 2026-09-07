import * as vscode from 'vscode';
import { forgetWorkspace, isRegistered, registerWorkspace } from './core/dataHome';

/** Root folder of the workspace the extension operates on, if any. */
export function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** A workspace is enabled once it is registered under the data home. */
export function isEnabled(root: string): boolean {
  return isRegistered(root);
}

/**
 * Register the workspace under the data home. Nothing is written into the
 * project folder or its repository, so there is nothing to hide from git and
 * nothing to ask the user.
 */
export function enableWorkspace(root: string): void {
  registerWorkspace(root);
}

/** Delete every trace of the workspace: baselines, events and review log. */
export function disableWorkspace(root: string): void {
  forgetWorkspace(root);
}
