/**
 * The flag tool's MCP server entry in the agent's user config, as pure
 * functions: what the entry should say, and what a config object says about
 * it. Writing the entry is the agent's own job (see src/flagServerInstaller.ts).
 * Its user config is a file the agent rewrites from its own memory as it runs,
 * so the extension reads that file and never writes it.
 */

/** Name the server is registered under, and the prefix of its tool names. */
export const SERVER_NAME = 'copyworkcode';

/** Identifies our server script, whatever path it was installed from. */
const SERVER_MARKER = 'copyworkcode-mcp.js';

export interface ServerSpec {
  type: 'stdio';
  command: string;
  args: string[];
}

export function serverSpec(script: string): ServerSpec {
  return { type: 'stdio', command: 'node', args: [script] };
}

export interface ServerEntry {
  /** An entry under our name is there. */
  registered: boolean;
  /** It runs the script this install would register. */
  current: boolean;
  /** The script it runs, when it names one of ours. */
  script?: string;
}

/** What a parsed user config says about our entry. Tolerates any shape. */
export function describeServer(config: unknown, expectedScript: string): ServerEntry {
  const servers = isPlainObject(config) ? config.mcpServers : undefined;
  const entry = isPlainObject(servers) ? servers[SERVER_NAME] : undefined;
  if (!isPlainObject(entry)) return { registered: false, current: false };
  const args = Array.isArray(entry.args) ? entry.args : [];
  const script = args.find(
    (arg): arg is string => typeof arg === 'string' && arg.includes(SERVER_MARKER)
  );
  if (!script) return { registered: true, current: false };
  return { registered: true, current: script === expectedScript, script };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
