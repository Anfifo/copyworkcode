import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { diffLines, hasDebt, normalizeEol } from '../src/core/diff';

test('identical texts produce no hunks', () => {
  assert.deepEqual(diffLines('a\nb\nc\n', 'a\nb\nc\n'), []);
});

test('line-ending differences are not debt', () => {
  assert.equal(hasDebt('a\r\nb\r\n', 'a\nb\n'), false);
  assert.deepEqual(diffLines('a\r\nb\r\n', 'a\nb\n'), []);
});

test('pure insertion', () => {
  const hunks = diffLines('a\nc\n', 'a\nb1\nb2\nc\n');
  assert.equal(hunks.length, 1);
  assert.deepEqual(hunks[0], {
    currentStart: 1,
    addedLines: ['b1', 'b2'],
    baseStart: 1,
    removedLines: [],
  });
});

test('pure deletion', () => {
  const hunks = diffLines('a\nb\nc\n', 'a\nc\n');
  assert.equal(hunks.length, 1);
  assert.deepEqual(hunks[0], {
    currentStart: 1,
    addedLines: [],
    baseStart: 1,
    removedLines: ['b'],
  });
});

test('replacement combines removed and added in one hunk', () => {
  const hunks = diffLines('a\nold\nc\n', 'a\nnew1\nnew2\nc\n');
  assert.equal(hunks.length, 1);
  assert.deepEqual(hunks[0].removedLines, ['old']);
  assert.deepEqual(hunks[0].addedLines, ['new1', 'new2']);
  assert.equal(hunks[0].currentStart, 1);
});

test('multiple separated hunks keep correct positions', () => {
  const base = 'a\nb\nc\nd\ne\n';
  const curr = 'a\nB\nc\nd\nE\nf\n';
  const hunks = diffLines(base, curr);
  assert.equal(hunks.length, 2);
  assert.deepEqual(hunks[0].addedLines, ['B']);
  assert.equal(hunks[0].currentStart, 1);
  assert.deepEqual(hunks[1].addedLines, ['E', 'f']);
  assert.deepEqual(hunks[1].removedLines, ['e']);
  assert.equal(hunks[1].currentStart, 4);
});

test('empty baseline means the whole file is one added hunk', () => {
  const hunks = diffLines('', 'a\nb\n');
  assert.equal(hunks.length, 1);
  assert.deepEqual(hunks[0].addedLines, ['a', 'b']);
  assert.equal(hunks[0].currentStart, 0);
});

test('file without trailing newline diffs correctly', () => {
  const hunks = diffLines('a\nb', 'a\nb\nc');
  assert.equal(hunks.length, 1);
  assert.deepEqual(hunks[0].addedLines, ['c']);
  assert.equal(hunks[0].currentStart, 2);
});

test('repeated lines resolve to a minimal change', () => {
  const base = '{\n}\n{\n}\n';
  const curr = '{\nx\n}\n{\n}\n';
  const hunks = diffLines(base, curr);
  const added = hunks.flatMap((h) => h.addedLines);
  const removed = hunks.flatMap((h) => h.removedLines);
  assert.deepEqual(added, ['x']);
  assert.deepEqual(removed, []);
});

test('normalizeEol only touches CRLF', () => {
  assert.equal(normalizeEol('a\r\nb\rc\n'), 'a\nb\rc\n');
});
