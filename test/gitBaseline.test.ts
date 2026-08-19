import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GitChange, gitBaseline, gitChanges } from '../src/core/gitBaseline';

const noGit = spawnSync('git', ['--version']).status !== 0;

function git(root: string, args: string[]): void {
  const done = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(done.status, 0, `git ${args.join(' ')} failed: ${done.stderr}`);
}

/** A repository with one commit: two text files and one binary one. */
function repoWithCommit(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwc-git-')));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, 'kept.ts'), 'one\ntwo\n');
  fs.writeFileSync(path.join(root, 'gone.ts'), 'x\n');
  fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([0, 1, 2, 0]));
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', 'first']);
  return root;
}

function byName(changes: GitChange[], root: string): Record<string, GitChange> {
  const map: Record<string, GitChange> = {};
  for (const change of changes) {
    map[path.relative(root, change.file).split(path.sep).join('/')] = change;
  }
  return map;
}

test('gitChanges reports edits, deletions and new files', { skip: noGit }, () => {
  const root = repoWithCommit();
  fs.writeFileSync(path.join(root, 'kept.ts'), 'one\ntwo\nthree\n');
  fs.rmSync(path.join(root, 'gone.ts'));
  fs.writeFileSync(path.join(root, 'fresh.ts'), 'new\nfile\n');
  fs.writeFileSync(path.join(root, 'fresh.bin'), Buffer.from([0, 9]));
  fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0]));

  const changes = gitChanges(root, 'HEAD');
  assert.ok(changes);
  const found = byName(changes, root);

  assert.deepEqual(found['kept.ts'], {
    file: path.join(root, 'kept.ts'),
    addedLines: 1,
    removedLines: 0,
    untracked: false,
  });
  assert.deepEqual(found['gone.ts'], {
    file: path.join(root, 'gone.ts'),
    addedLines: 0,
    removedLines: 1,
    untracked: false,
  });
  assert.deepEqual(found['fresh.ts'], {
    file: path.join(root, 'fresh.ts'),
    addedLines: 2,
    removedLines: 0,
    untracked: true,
  });
  assert.equal(found['blob.bin'], undefined, 'binary edits have no lines to review');
  assert.equal(found['fresh.bin'], undefined, 'new binaries are not reviewable either');
});

test('gitChanges follows a rename to its new path', { skip: noGit }, () => {
  const root = repoWithCommit();
  git(root, ['mv', 'kept.ts', 'moved.ts']);
  const found = byName(gitChanges(root, 'HEAD') ?? [], root);
  assert.ok(found['moved.ts'], 'the renamed file is listed under its new name');
  assert.equal(found['kept.ts'], undefined);
});

test('gitChanges is empty for a clean tree, undefined without a repo', { skip: noGit }, () => {
  const root = repoWithCommit();
  assert.deepEqual(gitChanges(root, 'HEAD'), []);
  assert.equal(gitChanges(root, 'no-such-revision'), undefined);
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'cwc-nogit-'));
  assert.equal(gitChanges(bare, 'HEAD'), undefined);
});

test('gitBaseline reads the committed content', { skip: noGit }, () => {
  const root = repoWithCommit();
  fs.writeFileSync(path.join(root, 'kept.ts'), 'rewritten\n');
  fs.writeFileSync(path.join(root, 'fresh.ts'), 'new\n');
  assert.equal(gitBaseline(root, 'HEAD', path.join(root, 'kept.ts')), 'one\ntwo\n');
  assert.equal(
    gitBaseline(root, 'HEAD', path.join(root, 'fresh.ts')),
    '',
    'a file absent from the revision has an empty baseline'
  );
  assert.equal(
    gitBaseline(root, 'HEAD', path.join(os.tmpdir(), 'elsewhere.ts')),
    undefined,
    'files outside the workspace are not ours to compare'
  );
});
