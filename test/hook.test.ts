import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const HOOK = path.resolve(__dirname, '..', '..', 'hook', 'copyworkcode-hook.js');

function runHook(payload: unknown): { status: number | null } {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const result = spawnSync(process.execPath, [HOOK], { input: raw });
  return { status: result.status };
}

function enabledWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cwc-hook-'));
  fs.mkdirSync(path.join(root, '.copyworkcode'));
  return root;
}

function readEvents(root: string): any[] {
  const file = path.join(root, '.copyworkcode', 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function payload(
  root: string,
  hookEvent: 'PreToolUse' | 'PostToolUse',
  toolName: string,
  toolInput: Record<string, unknown>
) {
  return {
    session_id: 'sess-1',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: root,
    hook_event_name: hookEvent,
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: 'toolu_123',
  };
}

test('PreToolUse snapshots the pre-change content as the baseline', () => {
  const root = enabledWorkspace();
  const file = path.join(root, 'src', 'a.ts');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'original\n');

  const { status } = runHook(
    payload(root, 'PreToolUse', 'Edit', {
      file_path: file,
      old_string: 'original',
      new_string: 'changed',
    })
  );
  assert.equal(status, 0);

  const baseline = path.join(root, '.copyworkcode', 'baselines', 'src%2Fa.ts');
  assert.equal(fs.readFileSync(baseline, 'utf8'), 'original\n');
});

test('PreToolUse never overwrites an existing baseline', () => {
  const root = enabledWorkspace();
  const file = path.join(root, 'a.ts');
  fs.writeFileSync(file, 'v1\n');
  runHook(payload(root, 'PreToolUse', 'Edit', { file_path: file, old_string: '', new_string: '' }));
  fs.writeFileSync(file, 'v2\n');
  runHook(payload(root, 'PreToolUse', 'Edit', { file_path: file, old_string: '', new_string: '' }));

  const baseline = path.join(root, '.copyworkcode', 'baselines', 'a.ts');
  assert.equal(fs.readFileSync(baseline, 'utf8'), 'v1\n');
});

test('PreToolUse for a file that does not exist yet records an empty baseline', () => {
  const root = enabledWorkspace();
  const file = path.join(root, 'new.ts');
  runHook(payload(root, 'PreToolUse', 'Write', { file_path: file, content: 'fresh\n' }));

  const baseline = path.join(root, '.copyworkcode', 'baselines', 'new.ts');
  assert.equal(fs.readFileSync(baseline, 'utf8'), '');
});

test('PostToolUse appends an event with change content and intent pointers', () => {
  const root = enabledWorkspace();
  const file = path.join(root, 'src', 'a.ts');
  runHook(
    payload(root, 'PostToolUse', 'Edit', {
      file_path: file,
      old_string: 'before',
      new_string: 'after',
    })
  );

  const events = readEvents(root);
  assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(e.id, 'toolu_123');
  assert.equal(e.source, 'agent-hook');
  assert.equal(e.agent, 'claude-code');
  assert.equal(e.file, file);
  assert.equal(e.toolName, 'Edit');
  assert.deepEqual(e.change, { kind: 'edit', oldText: 'before', newText: 'after' });
  assert.deepEqual(e.intentRef, {
    transcriptPath: '/tmp/transcript.jsonl',
    sessionId: 'sess-1',
    toolUseId: 'toolu_123',
  });
});

test('PostToolUse Write records the written content', () => {
  const root = enabledWorkspace();
  const file = path.join(root, 'w.ts');
  runHook(payload(root, 'PostToolUse', 'Write', { file_path: file, content: 'body\n' }));
  const events = readEvents(root);
  assert.deepEqual(events[0].change, { kind: 'write', content: 'body\n' });
});

test('NotebookEdit records the occurrence without content', () => {
  const root = enabledWorkspace();
  const nb = path.join(root, 'n.ipynb');
  runHook(
    payload(root, 'PostToolUse', 'NotebookEdit', {
      notebook_path: nb,
      cell_id: 'c1',
      source: 'print(1)',
    })
  );
  const events = readEvents(root);
  assert.equal(events.length, 1);
  assert.equal(events[0].file, nb);
  assert.equal(events[0].change, undefined);
});

test('relative file paths resolve against cwd', () => {
  const root = enabledWorkspace();
  runHook(
    payload(root, 'PostToolUse', 'Edit', {
      file_path: path.join('src', 'rel.ts'),
      old_string: 'a',
      new_string: 'b',
    })
  );
  const events = readEvents(root);
  assert.equal(events[0].file, path.join(root, 'src', 'rel.ts'));
});

test('does nothing in a workspace that has not enabled the extension', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cwc-disabled-'));
  const file = path.join(root, 'a.ts');
  fs.writeFileSync(file, 'x\n');
  runHook(payload(root, 'PreToolUse', 'Edit', { file_path: file, old_string: '', new_string: '' }));
  runHook(payload(root, 'PostToolUse', 'Edit', { file_path: file, old_string: '', new_string: '' }));
  assert.equal(fs.existsSync(path.join(root, '.copyworkcode')), false);
});

test('ignores non-file tools', () => {
  const root = enabledWorkspace();
  runHook(payload(root, 'PostToolUse', 'Bash', { command: 'ls' }));
  assert.deepEqual(readEvents(root), []);
});

test('files outside the workspace are not baselined', () => {
  const root = enabledWorkspace();
  const outside = path.join(os.tmpdir(), 'cwc-outside.ts');
  fs.writeFileSync(outside, 'x\n');
  runHook(payload(root, 'PreToolUse', 'Edit', { file_path: outside, old_string: '', new_string: '' }));
  assert.equal(
    fs.existsSync(path.join(root, '.copyworkcode', 'baselines')),
    false
  );
});

test('corrupt stdin exits 0 and writes nothing', () => {
  const { status } = runHook('this is not json');
  assert.equal(status, 0);
});

test('oversized content is dropped from the event but the event is kept', () => {
  const root = enabledWorkspace();
  const file = path.join(root, 'big.ts');
  const big = 'x'.repeat(600 * 1024);
  runHook(payload(root, 'PostToolUse', 'Write', { file_path: file, content: big }));
  const events = readEvents(root);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].change, { kind: 'write', content: '' });
});
