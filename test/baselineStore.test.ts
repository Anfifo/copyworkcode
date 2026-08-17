import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  advanceBaseline,
  baselineKey,
  filesWithDebt,
  readBaseline,
  trackedFiles,
} from '../src/core/baselineStore';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cwc-baseline-'));
}

test('baselineKey encodes workspace-relative paths and rejects outsiders', () => {
  const root = path.join(os.tmpdir(), 'proj');
  assert.equal(
    baselineKey(root, path.join(root, 'src', 'a b.ts')),
    'src%2Fa%20b.ts'
  );
  assert.equal(baselineKey(root, path.join(os.tmpdir(), 'other', 'x.ts')), undefined);
});

test('advance and read round-trip', () => {
  const root = tempRoot();
  const file = path.join(root, 'src', 'x.ts');
  assert.equal(readBaseline(root, file), undefined);
  advanceBaseline(root, file, 'hello\n');
  assert.equal(readBaseline(root, file), 'hello\n');
  assert.deepEqual(trackedFiles(root), [file]);
});

test('filesWithDebt reports only files that differ from baseline', () => {
  const root = tempRoot();
  const changed = path.join(root, 'changed.ts');
  const clean = path.join(root, 'clean.ts');
  fs.writeFileSync(changed, 'new content\n');
  fs.writeFileSync(clean, 'same\n');
  advanceBaseline(root, changed, 'old content\n');
  advanceBaseline(root, clean, 'same\n');

  const debt = filesWithDebt(root);
  assert.deepEqual(debt.map((d) => d.file), [changed]);
  assert.equal(debt[0].baseline, 'old content\n');
  assert.equal(debt[0].current, 'new content\n');
});

test('a deleted file with a baseline still shows debt', () => {
  const root = tempRoot();
  const gone = path.join(root, 'gone.ts');
  advanceBaseline(root, gone, 'was here\n');
  const debt = filesWithDebt(root);
  assert.equal(debt.length, 1);
  assert.equal(debt[0].current, '');
});

test('EOL-only differences are not debt', () => {
  const root = tempRoot();
  const file = path.join(root, 'eol.ts');
  fs.writeFileSync(file, 'a\r\nb\r\n');
  advanceBaseline(root, file, 'a\nb\n');
  assert.deepEqual(filesWithDebt(root), []);
});
