import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { matchesAny } from '../src/core/glob';

test('double star matches across path segments', () => {
  assert.equal(matchesAny('/a/b/package-lock.json', ['**/package-lock.json']), true);
  assert.equal(matchesAny('C:\\a\\b\\package-lock.json', ['**/package-lock.json']), true);
  assert.equal(matchesAny('/a/b/package.json', ['**/package-lock.json']), false);
});

test('single star stays within a segment', () => {
  assert.equal(matchesAny('/a/x.lock', ['**/*.lock']), true);
  assert.equal(matchesAny('/a/b/c.lock', ['/a/*.lock']), false);
});

test('directory glob matches contents', () => {
  assert.equal(matchesAny('/p/node_modules/x/y.js', ['**/node_modules/**']), true);
  assert.equal(matchesAny('/p/src/y.js', ['**/node_modules/**']), false);
});

test('question mark matches exactly one character', () => {
  assert.equal(matchesAny('/a/f1.ts', ['/a/f?.ts']), true);
  assert.equal(matchesAny('/a/f12.ts', ['/a/f?.ts']), false);
});
