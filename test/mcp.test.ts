import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HOME_ENV, registerWorkspace } from '../src/core/dataHome';
import { flagsPath } from '../src/core/paths';

const SERVER = path.resolve(__dirname, '..', '..', 'mcp', 'copyworkcode-mcp.js');

/**
 * The server is spawned as the agent spawns it: one JSON-RPC message per line
 * on stdin, one answer per request on stdout, and it exits when stdin closes.
 * Every message is written up front, which a line-at-a-time server answers in
 * order just the same.
 */
function talk(projectDir: string, messages: object[]): any[] {
  const input = messages.map((m) => JSON.stringify({ jsonrpc: '2.0', ...m })).join('\n') + '\n';
  const result = spawnSync(process.execPath, [SERVER], {
    input,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

const INIT = {
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't' } },
};
const INITIALIZED = { method: 'notifications/initialized' };

function call(id: number, args: Record<string, unknown>) {
  return { id, method: 'tools/call', params: { name: 'flag_for_review', arguments: args } };
}

function workspace(files: Record<string, string> = {}): string {
  process.env[HOME_ENV] = fs.mkdtempSync(path.join(os.tmpdir(), 'cwc-mcp-home-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cwc-mcp-'));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  return root;
}

function readFlags(root: string): any[] {
  if (!fs.existsSync(flagsPath(root))) return [];
  return fs
    .readFileSync(flagsPath(root), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

test('in an enabled workspace the server offers the tool and says when to use it', () => {
  const root = workspace();
  registerWorkspace(root);
  const [init, list] = talk(root, [INIT, INITIALIZED, { id: 2, method: 'tools/list' }]);
  assert.equal(init.id, 1);
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.match(init.result.instructions, /flag_for_review/);
  assert.deepEqual(
    list.result.tools.map((t: { name: string }) => t.name),
    ['flag_for_review']
  );
  assert.deepEqual(list.result.tools[0].inputSchema.required, [
    'file',
    'excerpt',
    'importance',
    'reason',
  ]);
});

test('anywhere else the server offers nothing and says nothing', () => {
  const root = workspace();
  const [init, list] = talk(root, [INIT, INITIALIZED, { id: 2, method: 'tools/list' }]);
  assert.equal(init.result.instructions, undefined);
  assert.deepEqual(list.result.tools, []);
});

test('a flag is recorded with where its excerpt was found', () => {
  const root = workspace({ 'src/auth.ts': 'import x;\n\nif (expired(token)) {\n  deny();\n}\n' });
  registerWorkspace(root);
  const [, answer] = talk(root, [
    INIT,
    call(2, {
      file: 'src/auth.ts',
      excerpt: 'if (expired(token)) {\n  deny();',
      importance: 'must-type',
      reason: 'The expiry check guards every request.',
      intent: 'Reject expired sessions.',
    }),
  ]);
  assert.equal(answer.result.isError, false);
  assert.match(answer.result.content[0].text, /lines 3-4 of src\/auth\.ts as must-type/);
  const [record] = readFlags(root);
  assert.equal(record.file, path.join(root, 'src', 'auth.ts'));
  assert.equal(record.offset, 11);
  assert.equal(record.importance, 'must-type');
  assert.equal(record.reason, 'The expiry check guards every request.');
  assert.equal(record.intent, 'Reject expired sessions.');
});

test('an excerpt that is not in the file, or not once, is refused with what to do', () => {
  const root = workspace({ 'a.ts': 'x();\nx();\n' });
  registerWorkspace(root);
  const base = { file: 'a.ts', importance: 'worth-typing', reason: 'r' };
  const [, missing, twice] = talk(root, [
    INIT,
    call(2, { ...base, excerpt: 'y();' }),
    call(3, { ...base, excerpt: 'x();' }),
  ]);
  assert.equal(missing.result.isError, true);
  assert.match(missing.result.content[0].text, /not in a\.ts/);
  assert.equal(twice.result.isError, true);
  assert.match(twice.result.content[0].text, /occurs 2 times/);
  assert.deepEqual(readFlags(root), []);
});

test('bad arguments, outside files and credentials files are refused', () => {
  const root = workspace({ '.env': 'KEY=1\n', 'a.ts': 'a();\n' });
  registerWorkspace(root);
  const ok = { file: 'a.ts', excerpt: 'a();', importance: 'must-type', reason: 'r' };
  const answers = talk(root, [
    INIT,
    call(2, { ...ok, importance: 'optional' }),
    call(3, { ...ok, reason: '  ' }),
    call(4, { ...ok, file: path.join(os.tmpdir(), 'elsewhere.ts') }),
    call(5, { ...ok, file: '.env', excerpt: 'KEY=1' }),
  ]).slice(1);
  assert.deepEqual(
    answers.map((a) => a.result.isError),
    [true, true, true, true]
  );
  assert.match(answers[3].result.content[0].text, /credentials file/);
  assert.deepEqual(readFlags(root), []);
});

test('an unknown method or tool is a protocol error, and a notification gets no answer', () => {
  const root = workspace();
  registerWorkspace(root);
  const answers = talk(root, [
    INIT,
    { method: 'notifications/cancelled', params: {} },
    { id: 2, method: 'resources/list' },
    { id: 3, method: 'tools/call', params: { name: 'other', arguments: {} } },
    { id: 4, method: 'ping' },
  ]);
  assert.deepEqual(
    answers.map((a) => a.id),
    [1, 2, 3, 4]
  );
  assert.equal(answers[1].error.code, -32601);
  assert.equal(answers[2].error.code, -32602);
  assert.deepEqual(answers[3].result, {});
});
