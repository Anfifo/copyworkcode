import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  HOOK_MATCHER,
  Settings,
  addHook,
  hasHook,
  removeHook,
} from '../src/core/hookSettings';

const OURS = 'node "/ext/1.0.0/hook/copyworkcode-hook.js"';
const MOVED = 'node "/ext/1.1.0/hook/copyworkcode-hook.js"';
const THEIRS = 'node /home/me/my-own-hook.js';

/** Settings carrying somebody else's hook on one of our events. */
function withForeignHook(): Settings {
  return {
    permissions: { allow: ['Bash(ls)'] },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: THEIRS }] }],
    },
  };
}

function commandsFor(settings: Settings, event: string): string[] {
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  const entries = (hooks?.[event] ?? []) as Array<{
    hooks?: Array<{ command?: string }>;
  }>;
  return entries.flatMap((entry) => (entry.hooks ?? []).map((h) => h.command ?? ''));
}

test('addHook installs on both capture events', () => {
  const settings: Settings = {};
  assert.equal(addHook(settings, OURS), 'changed');
  assert.deepEqual(commandsFor(settings, 'PreToolUse'), [OURS]);
  assert.deepEqual(commandsFor(settings, 'PostToolUse'), [OURS]);
  const entry = (settings.hooks as Record<string, Array<{ matcher: string }>>)
    .PreToolUse[0];
  assert.equal(entry.matcher, HOOK_MATCHER);
});

test('addHook is idempotent', () => {
  const settings: Settings = {};
  addHook(settings, OURS);
  assert.equal(addHook(settings, OURS), 'unchanged');
  assert.deepEqual(commandsFor(settings, 'PreToolUse'), [OURS]);
});

test('addHook repoints an entry installed from an older location', () => {
  const settings: Settings = {};
  addHook(settings, OURS);
  assert.equal(addHook(settings, MOVED), 'changed');
  assert.deepEqual(commandsFor(settings, 'PreToolUse'), [MOVED]);
  assert.deepEqual(commandsFor(settings, 'PostToolUse'), [MOVED]);
});

test('addHook leaves unrelated settings and foreign hooks alone', () => {
  const settings = withForeignHook();
  addHook(settings, OURS);
  assert.deepEqual(settings.permissions, { allow: ['Bash(ls)'] });
  assert.deepEqual(commandsFor(settings, 'PreToolUse'), [THEIRS, OURS]);
});

test('addHook refuses a hooks section it does not recognize', () => {
  const settings: Settings = { hooks: 'yes please' };
  assert.equal(addHook(settings, OURS), 'malformed');
  assert.equal(settings.hooks, 'yes please');

  const wrongEvent: Settings = { hooks: { PreToolUse: 'nope' } };
  assert.equal(addHook(wrongEvent, OURS), 'malformed');
  assert.deepEqual(wrongEvent.hooks, { PreToolUse: 'nope' });
});

test('removeHook undoes an install completely', () => {
  const settings: Settings = { permissions: { allow: [] } };
  addHook(settings, OURS);
  assert.equal(removeHook(settings), 'changed');
  assert.equal(hasHook(settings), false);
  // The hooks section existed only for us, so it goes too — the file returns
  // to what it looked like before capture was ever turned on.
  assert.equal('hooks' in settings, false);
  assert.deepEqual(settings.permissions, { allow: [] });
});

test('removeHook keeps foreign hooks sharing the same event', () => {
  const settings = withForeignHook();
  addHook(settings, OURS);
  assert.equal(removeHook(settings), 'changed');
  assert.deepEqual(commandsFor(settings, 'PreToolUse'), [THEIRS]);
  assert.equal(hasHook(settings), false);
});

test('removeHook keeps foreign hooks sharing the same entry', () => {
  const settings: Settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: HOOK_MATCHER,
          hooks: [
            { type: 'command', command: THEIRS },
            { type: 'command', command: OURS },
          ],
        },
      ],
    },
  };
  assert.equal(removeHook(settings), 'changed');
  assert.deepEqual(commandsFor(settings, 'PreToolUse'), [THEIRS]);
});

test('removeHook finds our hook under an event we never install to', () => {
  const settings: Settings = {
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: OURS }] }] },
  };
  assert.equal(removeHook(settings), 'changed');
  assert.equal(hasHook(settings), false);
  assert.equal('hooks' in settings, false);
});

test('removeHook does nothing when the hook is absent', () => {
  const settings = withForeignHook();
  assert.equal(removeHook(settings), 'unchanged');
  assert.deepEqual(commandsFor(settings, 'PreToolUse'), [THEIRS]);

  assert.equal(removeHook({}), 'unchanged');
  assert.equal(removeHook({ hooks: 'garbage' }), 'unchanged');
});

test('hasHook recognizes any install location, and nothing else', () => {
  assert.equal(hasHook({}), false);
  assert.equal(hasHook(withForeignHook()), false);
  const settings: Settings = {};
  addHook(settings, OURS);
  assert.equal(hasHook(settings), true);
});
