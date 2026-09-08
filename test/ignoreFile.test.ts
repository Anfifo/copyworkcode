import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  IGNORE_FILE,
  appendIgnore,
  isIgnored,
  parseIgnore,
  readIgnoreRules,
  suggestPatterns,
} from '../src/core/ignoreFile';

function rules(text: string) {
  return parseIgnore(text);
}

test('a bare name matches at any depth, a leading slash anchors it', () => {
  const r = rules('*.lock\n/README.md\n');
  assert.equal(isIgnored('yarn.lock', r), true);
  assert.equal(isIgnored('packages/a/yarn.lock', r), true);
  assert.equal(isIgnored('README.md', r), true);
  assert.equal(isIgnored('docs/README.md', r), false);
});

test('a pattern with a slash is anchored, a trailing slash takes the folder', () => {
  const r = rules('docs/*.md\n/vendor/\n');
  assert.equal(isIgnored('docs/a.md', r), true);
  assert.equal(isIgnored('src/docs/a.md', r), false);
  assert.equal(isIgnored('vendor/lib/x.js', r), true);
  assert.equal(isIgnored('vendor', r), false);
});

test('comments and blanks are skipped, the last matching line wins', () => {
  const r = rules('# generated\n\n*.snap\n!keep.snap\n');
  assert.equal(isIgnored('test/a.snap', r), true);
  assert.equal(isIgnored('test/keep.snap', r), false);
  assert.equal(isIgnored('src/a.ts', r), false);
  assert.equal(isIgnored('anything', []), false);
});

test('backslashes read as separators either side', () => {
  const r = rules('src\\gen\\\n');
  assert.equal(isIgnored('src\\gen\\out.ts', r), true);
});

test('appendIgnore creates the file on the first line and keeps lines whole', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cwc-ignore-'));
  assert.deepEqual(readIgnoreRules(root), []);
  appendIgnore(root, '*.lock');
  appendIgnore(root, '/vendor/');
  assert.equal(fs.readFileSync(path.join(root, IGNORE_FILE), 'utf8'), '*.lock\n/vendor/\n');
  fs.appendFileSync(path.join(root, IGNORE_FILE), '# by hand, no newline');
  appendIgnore(root, 'x.txt');
  assert.equal(
    fs.readFileSync(path.join(root, IGNORE_FILE), 'utf8'),
    '*.lock\n/vendor/\n# by hand, no newline\nx.txt\n'
  );
  assert.equal(isIgnored('a/b.lock', readIgnoreRules(root)), true);
});

test('suggestPatterns offers the file, its folder and its extension', () => {
  assert.deepEqual(suggestPatterns('src/gen/schema.ts'), [
    '/src/gen/schema.ts',
    '/src/gen/',
    '*.ts',
  ]);
  assert.deepEqual(suggestPatterns('Makefile'), ['/Makefile']);
  assert.deepEqual(suggestPatterns('a\\b.md'), ['/a/b.md', '/a/', '*.md']);
});
