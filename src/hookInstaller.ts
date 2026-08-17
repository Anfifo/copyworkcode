import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

// Marker used to find our entries inside existing settings, whatever path the
// hook was installed from (extension updates move the install directory).
const HOOK_MARKER = 'copyworkcode-hook.js';
const MATCHER = 'Edit|Write|NotebookEdit';
// PreToolUse snapshots the pre-change baseline; PostToolUse records the event.
const HOOK_EVENTS = ['PreToolUse', 'PostToolUse'] as const;

function settingsFile(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

/** True when the capture hook is already present in the user's settings. */
export function isClaudeCodeHookInstalled(): boolean {
  try {
    return fs.readFileSync(settingsFile(), 'utf8').includes(HOOK_MARKER);
  } catch {
    return false;
  }
}

/**
 * Install the change-capture hook into Claude Code's user-scope settings
 * (~/.claude/settings.json). Callers own the consent: this runs only from the
 * explicit palette command or after the user accepted the enable-time offer.
 *
 * User scope is deliberate: the hook script itself no-ops in workspaces that
 * haven't enabled the extension, and installing once covers every project and
 * every terminal the agent runs in — including terminals outside the editor.
 */
export async function installClaudeCodeHook(
  context: vscode.ExtensionContext
): Promise<void> {
  const settingsPath = settingsFile();
  const hookScript = context.asAbsolutePath(
    path.join('hook', 'copyworkcode-hook.js')
  );
  const command = `node "${hookScript}"`;

  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (err) {
      void vscode.window.showErrorMessage(
        `CopyWorkCode: could not parse ${settingsPath} — fix it manually first. (${err})`
      );
      return;
    }
  }

  const hooks = ((settings.hooks as Record<string, unknown>) ??= {});
  let changed = false;
  for (const eventName of HOOK_EVENTS) {
    const entries = ((hooks[eventName] as unknown[]) ??= []);
    changed = upsertHook(entries, command) || changed;
  }

  if (changed) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    void vscode.window.showInformationMessage(
      `CopyWorkCode: capture hook added to ${settingsPath}. Sessions started from now on will record their edits.`
    );
  } else {
    void vscode.window.showInformationMessage(
      'CopyWorkCode: capture hook already installed.'
    );
  }
}

/** Returns true when the entries were modified. */
function upsertHook(entries: unknown[], command: string): boolean {
  let existing: { type: string; command: string } | undefined;
  for (const entry of entries as Array<{
    hooks?: Array<{ type: string; command: string }>;
  }>) {
    existing = entry.hooks?.find((h) => h.command?.includes(HOOK_MARKER));
    if (existing) break;
  }

  if (existing) {
    if (existing.command === command) {
      return false;
    }
    existing.command = command; // extension moved; point at the new location
    return true;
  }
  entries.push({
    matcher: MATCHER,
    hooks: [{ type: 'command', command }],
  });
  return true;
}
