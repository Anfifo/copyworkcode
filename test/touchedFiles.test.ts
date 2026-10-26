import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HOME_ENV } from '../src/core/dataHome';
import { touchedSince } from '../src/core/touchedFiles';

/** A workspace where every file was written well before `now`. */
function workspace(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cwc-touched-'));
  const past = new Date(Date.now() - 60_000);
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    fs.utimesSync(file, past, past);
  }
  return root;
}

function touch(root: string, rel: string, content = 'new\n'): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function names(root: string, files: string[]): string[] {
  return files.map((file) => path.relative(root, file).replace(/\\/g, '/')).sort();
}

test('reports files written at or after the moment, and nothing older', () => {
  const root = workspace({ 'src/a.ts': 'a', 'src/b.ts': 'b', 'README.md': 'r' });
  const since = Date.now() - 5_000;
  touch(root, 'src/b.ts');
  touch(root, 'src/deep/c.ts');
  assert.deepEqual(names(root, touchedSince(root, since)), ['src/b.ts', 'src/deep/c.ts']);
});

test('never enters the repository store or installed dependencies', () => {
  const root = workspace({ 'a.ts': 'a' });
  const since = Date.now() - 5_000;
  touch(root, '.git/index');
  touch(root, 'node_modules/x/index.js');
  touch(root, 'packages/app/node_modules/y/index.js');
  touch(root, 'packages/app/main.ts');
  assert.deepEqual(names(root, touchedSince(root, since)), ['packages/app/main.ts']);
});

test('the repository ignore file prunes folders and files without any git present', () => {
  const root = workspace({ '.gitignore': 'out/\n*.log\n/dist/\n!keep.log\n' });
  const since = Date.now() - 5_000;
  touch(root, 'out/main.js');
  touch(root, 'packages/lib/out/index.js');
  touch(root, 'dist/bundle.js');
  touch(root, 'src/dist/notbuild.ts');
  touch(root, 'debug.log');
  touch(root, 'keep.log');
  touch(root, 'src/main.ts');
  assert.deepEqual(names(root, touchedSince(root, since)), [
    'keep.log',
    'src/dist/notbuild.ts',
    'src/main.ts',
  ]);
});

test('a nested repository ignore file speaks for its own folder', () => {
  const root = workspace({
    '.gitignore': '*.tmp\n',
    'packages/app/.gitignore': 'generated/\n!important.tmp\n',
  });
  const since = Date.now() - 5_000;
  touch(root, 'packages/app/generated/x.ts');
  touch(root, 'packages/app/important.tmp');
  touch(root, 'packages/app/scratch.tmp');
  touch(root, 'generated/y.ts');
  assert.deepEqual(names(root, touchedSince(root, since)), [
    'generated/y.ts',
    'packages/app/important.tmp',
  ]);
});

test("the workspace's own ignore file applies too", () => {
  const root = workspace({ '.copyworkcodeignore': '/vendor/\n*.snap\n' });
  const since = Date.now() - 5_000;
  touch(root, 'vendor/lib.js');
  touch(root, 'test/a.snap');
  touch(root, 'test/a.ts');
  assert.deepEqual(names(root, touchedSince(root, since)), ['test/a.ts']);
});

test('the data home is skipped when it sits inside the workspace', () => {
  const root = workspace({ 'a.ts': 'a' });
  const previous = process.env[HOME_ENV];
  process.env[HOME_ENV] = path.join(root, '.copyworkcode');
  try {
    const since = Date.now() - 5_000;
    touch(root, '.copyworkcode/workspaces/x/events.jsonl');
    touch(root, 'b.ts');
    assert.deepEqual(names(root, touchedSince(root, since)), ['b.ts']);
  } finally {
    if (previous === undefined) delete process.env[HOME_ENV];
    else process.env[HOME_ENV] = previous;
  }
});

test('an unreadable folder is passed over', () => {
  const root = workspace({ 'a.ts': 'a' });
  assert.deepEqual(touchedSince(path.join(root, 'missing'), 0), []);
});
