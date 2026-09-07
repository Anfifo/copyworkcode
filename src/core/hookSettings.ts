/**
 * Pure transforms over an agent's settings object: adding the capture hook,
 * repointing it, and removing it again. Free of editor and filesystem APIs so
 * both directions can be unit-tested with plain Node — the file layer
 * (reading, atomic writing, messaging) is `src/hookInstaller.ts`.
 *
 * The file these run against belongs to the user and holds far more than this
 * hook, so every transform is surgical. Entries are found by marker rather
 * than by exact command text: the extension's install directory changes with
 * every update, so the command moves while the script name does not. Only hook
 * objects carrying that marker are touched, and a container is tidied away
 * only when the removal itself is what emptied it.
 */

/** Identifies our hook, whatever path it was installed from. */
const HOOK_MARKER = 'copyworkcode-hook.js';

/** Tool names the capture hook runs for. */
export const HOOK_MATCHER = 'Edit|Write|NotebookEdit';

/** PreToolUse snapshots the pre-change baseline; PostToolUse records the event. */
const HOOK_EVENTS = ['PreToolUse', 'PostToolUse'] as const;

export type Settings = Record<string, unknown>;

/**
 * `malformed` means the file's `hooks` section isn't shaped the way the agent
 * documents it. Adding refuses and leaves whatever is there alone;
 * removal tolerates any shape, since it can only ever take away.
 */
export type Change = 'changed' | 'unchanged' | 'malformed';

interface HookCommand {
  type?: string;
  command?: string;
}

interface HookEntry {
  matcher?: string;
  hooks?: HookCommand[];
}

/** True when any event in the file already carries our hook. */
export function hasHook(settings: Settings): boolean {
  const hooks = settings.hooks;
  if (!isPlainObject(hooks)) return false;
  for (const entries of Object.values(hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (entryHooks(entry)?.some(isOurCommand)) return true;
    }
  }
  return false;
}

/**
 * Put our hook on every capture event, or repoint the one already there.
 * Mutates `settings`; the caller writes it out only when the result is
 * `changed`, so a refusal leaves nothing half-applied.
 */
export function addHook(settings: Settings, command: string): Change {
  if (!hasUsableShape(settings)) return 'malformed';

  const hooks = isPlainObject(settings.hooks)
    ? settings.hooks
    : ((settings.hooks = {} as Record<string, unknown>) as Record<string, unknown>);

  let changed = false;
  for (const event of HOOK_EVENTS) {
    const existing = hooks[event];
    const entries = Array.isArray(existing)
      ? (existing as HookEntry[])
      : ((hooks[event] = [] as HookEntry[]) as HookEntry[]);
    if (upsert(entries, command)) changed = true;
  }
  return changed ? 'changed' : 'unchanged';
}

/**
 * Take our hook out of every event it appears under, wherever it sits — a
 * layout written by an older version still gets cleaned up. Entries and event
 * lists that existed only to run it go too; anything sharing them stays.
 */
export function removeHook(settings: Settings): Change {
  const hooks = settings.hooks;
  if (!isPlainObject(hooks)) return 'unchanged';

  let changed = false;
  for (const event of Object.keys(hooks)) {
    const entries = hooks[event];
    if (!Array.isArray(entries)) continue;

    const kept: unknown[] = [];
    let touched = false;
    for (const entry of entries) {
      const commands = entryHooks(entry);
      if (!commands) {
        kept.push(entry);
        continue;
      }
      const remaining = commands.filter((command) => !isOurCommand(command));
      if (remaining.length === commands.length) {
        kept.push(entry);
        continue;
      }
      touched = true;
      // An entry that existed only to run our hook goes with it; one that also
      // carries somebody else's hooks keeps those and stays.
      if (remaining.length > 0) {
        (entry as HookEntry).hooks = remaining;
        kept.push(entry);
      }
    }

    if (!touched) continue;
    changed = true;
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }

  if (changed && Object.keys(hooks).length === 0) delete settings.hooks;
  return changed ? 'changed' : 'unchanged';
}

/** Returns true when the entries were modified. */
function upsert(entries: HookEntry[], command: string): boolean {
  for (const entry of entries) {
    const ours = entryHooks(entry)?.find(isOurCommand);
    if (!ours) continue;
    if (ours.command === command) return false;
    ours.command = command; // the extension moved; point at the new location
    return true;
  }
  entries.push({ matcher: HOOK_MATCHER, hooks: [{ type: 'command', command }] });
  return true;
}

/** `hooks` absent, or an object whose every event is a list. */
function hasUsableShape(settings: Settings): boolean {
  const hooks = settings.hooks;
  if (hooks === undefined) return true;
  if (!isPlainObject(hooks)) return false;
  return Object.values(hooks).every((entries) => Array.isArray(entries));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function entryHooks(entry: unknown): HookCommand[] | undefined {
  if (!isPlainObject(entry)) return undefined;
  const hooks = (entry as HookEntry).hooks;
  return Array.isArray(hooks) ? hooks : undefined;
}

function isOurCommand(command: HookCommand | undefined): boolean {
  return (
    isPlainObject(command) &&
    typeof command.command === 'string' &&
    command.command.includes(HOOK_MARKER)
  );
}
