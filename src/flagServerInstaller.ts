import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { SERVER_NAME, ServerEntry, describeServer, serverSpec } from './core/flagServerConfig';

/**
 * Registers and removes the flag tool's MCP server in the agent's user config,
 * driven by the same `copyworkcode.agentCapture` setting as the capture hook.
 *
 * The config file (`~/.claude.json`) is the only place a server can be
 * registered for every project, and it is not a quiet file: the agent keeps it
 * in memory and saves over it as it runs. A write from here could race one of
 * those saves and lose either side. So every change goes through the agent's
 * own command line (`claude mcp add-json` and `claude mcp remove`), which is
 * the writer that file expects, and the file is only ever read here: to see
 * what is registered, and to confirm a change took.
 *
 * The command line is looked for on the PATH, then inside the agent's editor
 * extension, which ships its own copy. Without either, the check command shows
 * the line to run by hand.
 */

export type FlagSync =
  | 'installed'
  | 'repointed'
  | 'removed'
  | 'unchanged'
  | 'no-cli'
  | 'failed';

const AGENT_EXTENSION = 'anthropic.claude-code';
const CLI_TIMEOUT_MS = 60_000;

export function userConfigFile(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR?.trim();
  return dir ? path.join(dir, '.claude.json') : path.join(os.homedir(), '.claude.json');
}

function serverScript(context: vscode.ExtensionContext): string {
  return context.asAbsolutePath(path.join('mcp', 'copyworkcode-mcp.js'));
}

/** The line that registers the server by hand, for when no command line is found. */
export function manualCommand(context: vscode.ExtensionContext): string {
  return `claude mcp add --scope user ${SERVER_NAME} -- node "${serverScript(context)}"`;
}

export interface FlagServerReport {
  file: string;
  /** `missing` when the agent has no user config yet, `unreadable` when it will not parse. */
  fileState: 'found' | 'missing' | 'unreadable';
  entry: ServerEntry;
  /** The script this install would register. */
  expected: string;
  /** The command line that would make the change, when one is found. */
  cli?: string;
}

/** Look without touching, for the configuration check and before any change. */
export function inspectFlagServer(context: vscode.ExtensionContext): FlagServerReport {
  const file = userConfigFile();
  const expected = serverScript(context);
  const cli = findClaude();
  const absent: ServerEntry = { registered: false, current: false };
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { file, fileState: 'missing', entry: absent, expected, cli };
  }
  try {
    const entry = describeServer(JSON.parse(raw), expected);
    return { file, fileState: 'found', entry, expected, cli };
  } catch {
    return { file, fileState: 'unreadable', entry: absent, expected, cli };
  }
}

/**
 * Bring the registered server in line with `enabled`. Idempotent: a server
 * already registered from this install, or already absent, is left alone
 * without running anything. An entry under our name that runs some other
 * script is not ours, and turning capture off leaves it in place.
 */
export async function syncFlagServer(
  context: vscode.ExtensionContext,
  enabled: boolean
): Promise<FlagSync> {
  const before = inspectFlagServer(context);
  if (before.fileState === 'unreadable') return 'failed';
  const { entry } = before;
  if (enabled ? entry.current : !entry.script) return 'unchanged';
  const cli = before.cli;
  if (!cli) return 'no-cli';

  if (entry.script) await runClaude(cli, ['mcp', 'remove', SERVER_NAME, '--scope', 'user']);
  if (enabled) {
    const spec = JSON.stringify(serverSpec(before.expected));
    await runClaude(cli, ['mcp', 'add-json', SERVER_NAME, spec, '--scope', 'user']);
  }

  const after = inspectFlagServer(context).entry;
  if (enabled && !after.current) return 'failed';
  if (!enabled && after.script) return 'failed';
  if (!enabled) return 'removed';
  return entry.registered ? 'repointed' : 'installed';
}

/** The agent's command line: on the PATH, else the copy its editor extension ships. */
function findClaude(): string | undefined {
  const name = process.platform === 'win32' ? 'claude.exe' : 'claude';
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir && isFile(path.join(dir, name))) return path.join(dir, name);
  }
  const agent = vscode.extensions.getExtension(AGENT_EXTENSION);
  if (!agent) return undefined;
  const bundled = path.join(agent.extensionPath, 'resources', 'native-binary', name);
  return isFile(bundled) ? bundled : undefined;
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Run the command line and settle either way. The outcome is read back from
 * the config file afterwards, which is the fact that matters, so the exit
 * status is not consulted.
 */
function runClaude(cli: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    execFile(cli, args, { timeout: CLI_TIMEOUT_MS, windowsHide: true }, () => resolve());
  });
}
