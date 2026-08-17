import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureLocalGitExclude } from '../src/core/gitExclude';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cwc-exclude-'));
}

test('appends the entry to .git/info/exclude in a normal repo', () => {
  const root = tempDir();
  fs.mkdirSync(path.join(root, '.git'));
  ensureLocalGitExclude(root, '.copyworkcode/');
  assert.equal(
    fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8'),
    '.copyworkcode/\n'
  );
});

test('preserves existing exclude content and stays idempotent', () => {
  const root = tempDir();
  const info = path.join(root, '.git', 'info');
  fs.mkdirSync(info, { recursive: true });
  fs.writeFileSync(path.join(info, 'exclude'), '*.tmp\n');
  ensureLocalGitExclude(root, '.copyworkcode/');
  ensureLocalGitExclude(root, '.copyworkcode/');
  assert.equal(
    fs.readFileSync(path.join(info, 'exclude'), 'utf8'),
    '*.tmp\n.copyworkcode/\n'
  );
});

test('adds a missing newline before appending', () => {
  const root = tempDir();
  const info = path.join(root, '.git', 'info');
  fs.mkdirSync(info, { recursive: true });
  fs.writeFileSync(path.join(info, 'exclude'), '*.tmp');
  ensureLocalGitExclude(root, '.copyworkcode/');
  assert.equal(
    fs.readFileSync(path.join(info, 'exclude'), 'utf8'),
    '*.tmp\n.copyworkcode/\n'
  );
});

test('follows a gitdir pointer when .git is a file (worktree)', () => {
  const base = tempDir();
  const realGit = path.join(base, 'repo.git');
  fs.mkdirSync(realGit);
  const root = path.join(base, 'worktree');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, '.git'), `gitdir: ${realGit}\n`);
  ensureLocalGitExclude(root, '.copyworkcode/');
  assert.equal(
    fs.readFileSync(path.join(realGit, 'info', 'exclude'), 'utf8'),
    '.copyworkcode/\n'
  );
});

test('does nothing outside a git repository', () => {
  const root = tempDir();
  ensureLocalGitExclude(root, '.copyworkcode/');
  assert.deepEqual(fs.readdirSync(root), []);
});
