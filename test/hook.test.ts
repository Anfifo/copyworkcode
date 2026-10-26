import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HOME_ENV, registerWorkspace, workspaceDir } from '../src/core/dataHome';

const HOOK = path.resolve(__dirname, '..', '..', 'hook', 'copyworkcode-hook.js');

/**
 * The hook is spawned as the agent would spawn it, inheriting this process's
 * environment. Each test points the data home at a fresh temp folder first, so
 * the hook under test and the assertions below compute the same store and the
 * real one is never touched.
 */
function runHook(payload: unknown): { status: number | null } {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const result = spawnSync(process.execPath, [HOOK], { input: raw });
  return { status: result.status };
}

function isolatedHome(): void {
  process.env[HOME_ENV] = fs.mkdtempSync(path.join(os.tmpdir(), 'cwc-hook-home-'));
}

function enabledWorkspace(): string {
  isolatedHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cwc-hook-'));
  registerWorkspace(root);
  return root;
}

function baselinePath(root: string, key: string): string {
  return path.join(workspaceDir(root), 'baselines', key);
}

function readEvents(root: string): any[] {
  const file = path.join(workspaceDir(root), 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function payload(
  cwd: string,
  hookEvent: 'PreToolUse' | 'PostToolUse',
  toolName: string,
  toolInput: Record<string, unknown>
) {
  return {
    session_id: 'sess-1',
    transcript_path: '/tmp/transcript.jsonl',
    cwd,
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
  assert.equal(fs.readFileSync(baselinePath(root, 'src%2Fa.ts'), 'utf8'), 'original\n');
});

test('PreToolUse never overwrites an existing baseline', () => {
  const root = enabledWorkspace();
  const file = path.join(root, 'a.ts');
  fs.writeFileSync(file, 'v1\n');
  runHook(payload(root, 'PreToolUse', 'Edit', { file_path: file, old_string: '', new_string: '' }));
  fs.writeFileSync(file, 'v2\n');
  runHook(payload(root, 'PreToolUse', 'Edit', { file_path: file, old_string: '', new_string: '' }));

  assert.equal(fs.readFileSync(baselinePath(root, 'a.ts'), 'utf8'), 'v1\n');
});

test('PreToolUse for a file that does not exist yet records an empty baseline', () => {
  const root = enabledWorkspace();
  const file = path.join(root, 'new.ts');
  runHook(payload(root, 'PreToolUse', 'Write', { file_path: file, content: 'fresh\n' }));

  assert.equal(fs.readFileSync(baselinePath(root, 'new.ts'), 'utf8'), '');
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

test('a session started in a subfolder records into the workspace above it', () => {
  const root = enabledWorkspace();
  const cwd = path.join(root, 'packages', 'app');
  fs.mkdirSync(cwd, { recursive: true });
  const file = path.join(cwd, 'src', 'x.ts');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x1\n');

  runHook(payload(cwd, 'PreToolUse', 'Edit', { file_path: 'src/x.ts', old_string: '', new_string: '' }));
  runHook(payload(cwd, 'PostToolUse', 'Edit', { file_path: 'src/x.ts', old_string: 'x1', new_string: 'x2' }));

  assert.equal(
    fs.readFileSync(baselinePath(root, 'packages%2Fapp%2Fsrc%2Fx.ts'), 'utf8'),
    'x1\n'
  );
  const events = readEvents(root);
  assert.equal(events.length, 1);
  assert.equal(events[0].file, file);
});

test('does nothing in a workspace that has not enabled the extension', () => {
  isolatedHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cwc-disabled-'));
  const file = path.join(root, 'a.ts');
  fs.writeFileSync(file, 'x\n');
  runHook(payload(root, 'PreToolUse', 'Edit', { file_path: file, old_string: '', new_string: '' }));
  runHook(payload(root, 'PostToolUse', 'Edit', { file_path: file, old_string: '', new_string: '' }));
  assert.equal(fs.existsSync(workspaceDir(root)), false);
});

test('ignores tools that touch no files', () => {
  const root = enabledWorkspace();
  runHook(payload(root, 'PostToolUse', 'Grep', { pattern: 'x' }));
  assert.deepEqual(readEvents(root), []);
});

test('files outside the workspace are not baselined', () => {
  const root = enabledWorkspace();
  const outside = path.join(os.tmpdir(), 'cwc-outside.ts');
  fs.writeFileSync(outside, 'x\n');
  runHook(payload(root, 'PreToolUse', 'Edit', { file_path: outside, old_string: '', new_string: '' }));
  assert.equal(fs.existsSync(path.join(workspaceDir(root), 'baselines')), false);
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

test('a credentials file gets no baseline snapshot', () => {
  const root = enabledWorkspace();
  const file = path.join(root, '.env');
  fs.writeFileSync(file, 'API_TOKEN=super-secret\n');
  runHook(
    payload(root, 'PreToolUse', 'Edit', {
      file_path: file,
      old_string: 'super-secret',
      new_string: 'rotated',
    })
  );
  assert.equal(fs.existsSync(path.join(workspaceDir(root), 'baselines')), false);
});

test('a credentials file is recorded as an occurrence without its content', () => {
  const root = enabledWorkspace();
  const file = path.join(root, 'config', 'secrets.json');
  runHook(
    payload(root, 'PostToolUse', 'Write', {
      file_path: file,
      content: '{ "token": "super-secret" }',
    })
  );
  const events = readEvents(root);
  assert.equal(events.length, 1);
  assert.equal(events[0].file, file);
  assert.equal(events[0].change, undefined);
  // The point of the exclusion: the secret is nowhere in the log, in any form.
  const raw = fs.readFileSync(path.join(workspaceDir(root), 'events.jsonl'), 'utf8');
  assert.equal(raw.includes('super-secret'), false);
});

test('code that handles secrets is captured in full', () => {
  const root = enabledWorkspace();
  const file = path.join(root, 'src', 'secrets.ts');
  runHook(
    payload(root, 'PostToolUse', 'Write', {
      file_path: file,
      content: 'export const key = read();\n',
    })
  );
  assert.deepEqual(readEvents(root)[0].change, {
    kind: 'write',
    content: 'export const key = read();\n',
  });
});

const noGit = spawnSync('git', ['--version']).status !== 0;

/** Stamp a file as written well before any command under test ran. */
function age(file: string): void {
  stampAgo(file, 60_000);
}

function commandPayload(
  cwd: string,
  hookEvent: 'PreToolUse' | 'PostToolUse',
  durationMs = 1000,
  tool = 'Bash'
) {
  return {
    ...payload(cwd, hookEvent, tool, { command: 'make' }),
    tool_response: { stdout: '', stderr: '', interrupted: false, isImage: false },
    duration_ms: durationMs,
  };
}

/** Stamp a file as written `ms` ago. */
function stampAgo(file: string, ms: number): void {
  const at = new Date(Date.now() - ms);
  fs.utimesSync(file, at, at);
}

test('a long command records what it wrote early in its run', () => {
  const root = enabledWorkspace();
  const early = path.join(root, 'early.ts');
  fs.writeFileSync(early, 'early\n');
  stampAgo(early, 20_000);
  const before = path.join(root, 'before.ts');
  fs.writeFileSync(before, 'before\n');
  stampAgo(before, 40_000);

  runHook(commandPayload(root, 'PostToolUse', 30_000));
  assert.deepEqual(
    readEvents(root).map((e) => e.file),
    [early]
  );
});

test('a PowerShell command is recorded like a Bash one', () => {
  const root = enabledWorkspace();
  const written = path.join(root, 'out.txt');
  fs.writeFileSync(written, 'written\n');

  runHook(commandPayload(root, 'PostToolUse', 1000, 'PowerShell'));
  const events = readEvents(root);
  assert.equal(events.length, 1);
  assert.equal(events[0].file, written);
  assert.equal(events[0].toolName, 'PowerShell');
});

test('a command run records the files written meanwhile, without content', () => {
  const root = enabledWorkspace();
  const old = path.join(root, 'old.ts');
  fs.writeFileSync(old, 'old\n');
  age(old);
  const written = path.join(root, 'src', 'gen.ts');
  fs.mkdirSync(path.dirname(written), { recursive: true });
  fs.writeFileSync(written, 'generated\n');

  const { status } = runHook(commandPayload(root, 'PostToolUse'));
  assert.equal(status, 0);
  const events = readEvents(root);
  assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(e.file, written);
  assert.equal(e.toolName, 'Bash');
  assert.equal(e.change, undefined);
  assert.equal(e.id, 'toolu_123:src%2Fgen.ts');
  assert.equal(e.intentRef.toolUseId, 'toolu_123');
  // Nothing knew the file before, so all of it is new.
  assert.equal(fs.readFileSync(baselinePath(root, 'src%2Fgen.ts'), 'utf8'), '');
  assert.equal(fs.existsSync(baselinePath(root, 'old.ts')), false);
});

test('a command run leaves a tracked file alone unless it differs from its baseline', () => {
  const root = enabledWorkspace();
  const same = path.join(root, 'same.ts');
  const changed = path.join(root, 'changed.ts');
  fs.writeFileSync(same, 'v1\n');
  fs.writeFileSync(changed, 'v1\n');
  runHook(payload(root, 'PreToolUse', 'Edit', { file_path: same, old_string: '', new_string: '' }));
  runHook(payload(root, 'PreToolUse', 'Edit', { file_path: changed, old_string: '', new_string: '' }));
  fs.writeFileSync(same, 'v1\n');
  fs.writeFileSync(changed, 'v2\n');

  runHook(commandPayload(root, 'PostToolUse'));
  assert.deepEqual(
    readEvents(root).map((e) => e.file),
    [changed]
  );
  assert.equal(fs.readFileSync(baselinePath(root, 'same.ts'), 'utf8'), 'v1\n');
});

test('with git present, a file left as committed is not recorded and a changed one starts from its committed content', { skip: noGit }, () => {
  const root = enabledWorkspace();
  const git = (args: string[]) => spawnSync('git', args, { cwd: root });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'commit.gpgsign', 'false']);
  const kept = path.join(root, 'kept.ts');
  const edited = path.join(root, 'edited.ts');
  fs.writeFileSync(kept, 'kept\n');
  fs.writeFileSync(edited, 'before\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'first']);
  fs.writeFileSync(kept, 'kept\n');
  fs.writeFileSync(edited, 'after\n');

  runHook(commandPayload(root, 'PostToolUse'));
  assert.deepEqual(
    readEvents(root).map((e) => e.file),
    [edited]
  );
  assert.equal(fs.readFileSync(baselinePath(root, 'edited.ts'), 'utf8'), 'before\n');
  assert.equal(fs.existsSync(baselinePath(root, 'kept.ts')), false);
});

test('a command run skips what the ignore files leave out', () => {
  const root = enabledWorkspace();
  fs.writeFileSync(path.join(root, '.gitignore'), 'out/\n');
  age(path.join(root, '.gitignore'));
  fs.mkdirSync(path.join(root, 'out'));
  fs.writeFileSync(path.join(root, 'out', 'bundle.js'), 'built\n');
  fs.mkdirSync(path.join(root, 'node_modules', 'dep'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'dep', 'index.js'), 'dep\n');
  const source = path.join(root, 'main.ts');
  fs.writeFileSync(source, 'main\n');

  runHook(commandPayload(root, 'PostToolUse'));
  assert.deepEqual(
    readEvents(root).map((e) => e.file),
    [source]
  );
});

test('a credentials file written by a command is an occurrence with no baseline', () => {
  const root = enabledWorkspace();
  const env = path.join(root, '.env');
  fs.writeFileSync(env, 'TOKEN=super-secret\n');

  runHook(commandPayload(root, 'PostToolUse'));
  const events = readEvents(root);
  assert.equal(events.length, 1);
  assert.equal(events[0].file, env);
  assert.equal(events[0].change, undefined);
  assert.equal(fs.existsSync(path.join(workspaceDir(root), 'baselines')), false);
  const raw = fs.readFileSync(path.join(workspaceDir(root), 'events.jsonl'), 'utf8');
  assert.equal(raw.includes('super-secret'), false);
});

test('a command about to run records nothing', () => {
  const root = enabledWorkspace();
  fs.writeFileSync(path.join(root, 'a.ts'), 'a\n');
  runHook(commandPayload(root, 'PreToolUse'));
  assert.deepEqual(readEvents(root), []);
  assert.equal(fs.existsSync(path.join(workspaceDir(root), 'baselines')), false);
});
