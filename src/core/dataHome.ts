import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Where the runtime data lives: a folder in the user's home, with one
 * subfolder per workspace. Nothing is written inside the project itself, and
 * nothing is written into its git directory.
 *
 * The home folder rather than the editor's own storage, because the capture
 * hook is a bare Node process with no editor API and only its working
 * directory to go on, and because a second editor on the same machine should
 * see the same review state. `COPYWORKCODE_HOME` relocates the whole tree,
 * which is also how tests keep their data apart.
 *
 * A workspace's folder is named by a hash of its canonical path. The path is
 * also written in clear into `workspace.json`, so the folders can be read by a
 * person and so a workspace that has moved can be recognised later. The
 * extension and the hook both compute the key from a path, so the canonical
 * form below has to absorb every way the same folder can be spelled: relative
 * or absolute, either separator, a trailing separator, a lower-case drive
 * letter, a symlink.
 */

export const HOME_ENV = 'COPYWORKCODE_HOME';
const WORKSPACES_DIR = 'workspaces';
const MANIFEST_FILE = 'workspace.json';

export function dataHome(): string {
  const configured = process.env[HOME_ENV]?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.copyworkcode');
}

/** One spelling for a folder, whichever the caller used. */
export function canonicalRoot(root: string): string {
  let resolved = path.resolve(root);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {
    // The folder may be gone (forgetting a deleted workspace); keep the
    // resolved spelling so the key still matches what was registered.
  }
  resolved = resolved.replace(/[\\/]+$/, '');
  const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
  return (caseInsensitive ? resolved.toLowerCase() : resolved).replace(/\\/g, '/');
}

export function workspaceKey(root: string): string {
  return crypto.createHash('sha1').update(canonicalRoot(root)).digest('hex').slice(0, 16);
}

/** The workspace's own folder under the data home. */
export function workspaceDir(root: string): string {
  return path.join(dataHome(), WORKSPACES_DIR, workspaceKey(root));
}

/** A workspace is enabled once it has been registered here. */
export function isRegistered(root: string): boolean {
  return fs.existsSync(path.join(workspaceDir(root), MANIFEST_FILE));
}

export function registerWorkspace(root: string): void {
  const dir = workspaceDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = path.join(dir, MANIFEST_FILE);
  if (fs.existsSync(manifest)) return;
  const record = { path: path.resolve(root), since: new Date().toISOString() };
  fs.writeFileSync(manifest, JSON.stringify(record, null, 2) + '\n');
}

/** Delete everything kept for the workspace: baselines, events, review log. */
export function forgetWorkspace(root: string): void {
  fs.rmSync(workspaceDir(root), { recursive: true, force: true });
}

/**
 * The nearest registered workspace at or above `dir`. This is how the hook
 * finds its way in from an agent's working directory, which may be a
 * subfolder of the workspace the editor has open.
 */
export function registeredRootFor(dir: string): string | undefined {
  let current = path.resolve(dir);
  for (;;) {
    if (isRegistered(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
