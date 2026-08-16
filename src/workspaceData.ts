import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export const DATA_DIR = '.copyworkcode';
export const EVENTS_FILE = 'events.jsonl';
export const STATE_FILE = 'state.json';

/** Root folder of the workspace the extension operates on, if any. */
export function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function dataDir(root: string): string {
  return path.join(root, DATA_DIR);
}

export function eventsPath(root: string): string {
  return path.join(dataDir(root), EVENTS_FILE);
}

export function statePath(root: string): string {
  return path.join(dataDir(root), STATE_FILE);
}

/** A workspace is enabled once its data directory exists. */
export function isEnabled(root: string): boolean {
  return fs.existsSync(dataDir(root));
}

/** Create the data directory and make sure git never picks it up. */
export async function enableWorkspace(root: string): Promise<void> {
  fs.mkdirSync(dataDir(root), { recursive: true });

  const gitignore = path.join(root, '.gitignore');
  const entry = `${DATA_DIR}/`;
  let current = '';
  try {
    current = fs.readFileSync(gitignore, 'utf8');
  } catch {
    // no .gitignore yet
  }
  if (!current.split(/\r?\n/).includes(entry)) {
    const choice = await vscode.window.showInformationMessage(
      `Add "${entry}" to .gitignore? It holds local review data that should not be committed.`,
      'Add',
      'Not now'
    );
    if (choice === 'Add') {
      const suffix = current.length === 0 || current.endsWith('\n') ? '' : '\n';
      fs.appendFileSync(gitignore, `${suffix}${entry}\n`);
    }
  }
}
