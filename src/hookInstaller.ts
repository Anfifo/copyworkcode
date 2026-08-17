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

/**
 * Install the change-capture hook into Claude Code's user-scope settings
 * (~/.claude/settings.json), after explicit confirmation.
 *
 * User scope is deliberate: the hook script itself no-ops in workspaces that
 * haven't enabled the extension, and installing once covers every project and
 * every terminal the agent runs in — including terminals outside the editor.
 */
export async function installClaudeCodeHook(
  context: vscode.ExtensionContext
): Promise<void> {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  const hookScript = context.asAbsolutePath(
    path.join('hook', 'copyworkcode-hook.js')
  );
  const command = `node "${hookScript}"`;

  const choice = await vscode.window.showInformationMessage(
    `Install the CopyWorkCode capture hook into ${settingsPath}? ` +
      'It records file changes made by Claude Code, only in workspaces where CopyWorkCode is enabled.',
    { modal: true },
    'Install'
  );
  if (choice !== 'Install') {
    return;
  }

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
      'CopyWorkCode: capture hook installed. Running Claude Code sessions pick it up automatically.'
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
