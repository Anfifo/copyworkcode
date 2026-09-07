import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  Change,
  Settings,
  addHook,
  hasHook,
  removeHook,
} from './core/hookSettings';

/**
 * Installs and removes the change-capture hook in the agent's user-scope
 * settings (`~/.claude/settings.json`).
 *
 * Nothing here runs on its own. The `copyworkcode.agentCapture` setting is the
 * single expression of intent — off by default — and this module's job is to
 * make the file match it. Capture is worth an explicit choice rather than a
 * prompt: the file is global to every project and every terminal the agent
 * runs in, which is exactly why installing once is enough, and exactly why it
 * shouldn't happen because someone dismissed a notification.
 *
 * User scope is deliberate. The hook script no-ops in workspaces that haven't
 * enabled the extension, so one entry covers every project without recording
 * anywhere it wasn't asked to.
 */

export type CaptureSync =
  | 'installed'
  | 'repointed'
  | 'removed'
  | 'unchanged'
  | 'failed';

function settingsFile(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

/**
 * Bring the installed hook in line with `enabled`, and report what that took.
 *
 * Idempotent in both directions, so it is safe to call on every activation:
 * with capture off and no settings file — the default — it returns without
 * opening anything. That is what keeps a fresh install from touching a file it
 * was never given permission to touch.
 */
export function syncCaptureHook(
  context: vscode.ExtensionContext,
  enabled: boolean
): CaptureSync {
  const file = settingsFile();
  const present = fs.existsSync(file);
  if (!enabled && !present) return 'unchanged';

  let settings: Settings = {};
  if (present) {
    const parsed = readSettings(file);
    if (parsed === undefined) return 'failed';
    settings = parsed;
  }

  const existed = hasHook(settings);
  const command = `node "${context.asAbsolutePath(
    path.join('hook', 'copyworkcode-hook.js')
  )}"`;
  const result: Change = enabled ? addHook(settings, command) : removeHook(settings);

  if (result === 'malformed') {
    void vscode.window.showErrorMessage(
      `CopyWorkCode: the "hooks" section of ${file} isn't in the expected format, so it was left alone. Add the hook by hand, or fix the section and turn capture on again.`
    );
    return 'failed';
  }
  if (result === 'unchanged') return 'unchanged';

  try {
    writeSettings(file, settings);
  } catch (err) {
    void vscode.window.showErrorMessage(
      `CopyWorkCode: could not update ${file} (${err}). Your settings were left as they were.`
    );
    return 'failed';
  }

  if (!enabled) return 'removed';
  return existed ? 'repointed' : 'installed';
}

function readSettings(file: string): Settings | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    void vscode.window.showErrorMessage(
      `CopyWorkCode: could not read ${file} (${err}).`
    );
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('settings root is not an object');
    }
    return parsed as Settings;
  } catch (err) {
    void vscode.window.showErrorMessage(
      `CopyWorkCode: could not parse ${file} — fix it manually first. (${err})`
    );
    return undefined;
  }
}

/**
 * Write beside the target, then rename over it. A rename within one directory
 * is atomic, so an interrupted or failed write can never leave the file
 * half-written: either the old settings survive intact or the new ones replace
 * them whole. Worth the extra step for a file that is the user's own and holds
 * far more than this one hook.
 */
function writeSettings(file: string, settings: Settings): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.copyworkcode-tmp`;
  fs.writeFileSync(temp, JSON.stringify(settings, null, 2) + '\n');
  try {
    fs.renameSync(temp, file);
  } catch (err) {
    try {
      fs.unlinkSync(temp);
    } catch {
      // Nothing more to do: the target was never touched.
    }
    throw err;
  }
}
