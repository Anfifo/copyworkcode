import { strict as assert } from 'assert';
import { test } from 'node:test';
import {
  Flag,
  PlacedFlag,
  flagFor,
  nextFlagged,
  occurrences,
  parseFlags,
  placeFlags,
} from '../src/core/flags';
import { Section, buildSections } from '../src/core/sections';

function flag(over: Partial<Flag> = {}): Flag {
  return {
    id: 'f1',
    timestamp: '2026-10-26T10:00:00.000Z',
    file: '/w/a.ts',
    excerpt: 'check(token)',
    offset: 0,
    importance: 'must-type',
    reason: 'expiry is checked here',
    ...over,
  };
}

function placed(start: number, end: number, over: Partial<PlacedFlag> = {}): PlacedFlag {
  return {
    start,
    end,
    importance: 'must-type',
    reason: 'r',
    timestamp: '2026-10-26T10:00:00.000Z',
    ...over,
  };
}

test('parseFlags keeps well-formed lines and skips the rest', () => {
  const raw = [
    JSON.stringify(flag()),
    'not json',
    JSON.stringify({ ...flag(), importance: 'optional' }),
    JSON.stringify({ ...flag(), excerpt: '' }),
    '',
    JSON.stringify(flag({ id: 'f2', intent: 'guard the session' })),
  ].join('\n');
  assert.deepEqual(
    parseFlags(raw).map((f) => f.id),
    ['f1', 'f2']
  );
});

test('occurrences matches an excerpt quoted with plain newlines in a CRLF file', () => {
  const content = 'a\r\nb\r\nc\r\nb\r\n';
  assert.deepEqual(occurrences(content, 'b\nc'), [{ at: 3, length: 4 }]);
  assert.equal(occurrences(content, 'b').length, 2);
  assert.deepEqual(occurrences(content, ''), []);
});

test('placeFlags takes the repeat nearest where the flag was made, and drops a lost excerpt', () => {
  const content = 'x = 1;\nx = 1;\nx = 1;\n';
  const [near] = placeFlags(content, [flag({ excerpt: 'x = 1;', offset: 8 })]);
  assert.equal(near.start, 7);
  assert.equal(near.end, 13);
  assert.deepEqual(placeFlags(content, [flag({ excerpt: 'gone' })]), []);
});

test('flagFor prefers must-type, then the newest, among overlapping flags', () => {
  const section = { start: 10, end: 20 };
  const older = placed(12, 14, { reason: 'older', timestamp: '2026-10-26T09:00:00.000Z' });
  const newer = placed(15, 18, { reason: 'newer', timestamp: '2026-10-26T11:00:00.000Z' });
  const worth = placed(10, 20, {
    reason: 'worth',
    importance: 'worth-typing',
    timestamp: '2026-10-26T12:00:00.000Z',
  });
  assert.equal(flagFor(section, [worth, older, newer])?.reason, 'newer');
  assert.equal(flagFor(section, [worth])?.reason, 'worth');
  assert.equal(flagFor(section, [placed(20, 25)]), undefined, 'touching the end is not overlap');
});

test('a deletion carries a flag on the line it sits at', () => {
  assert.equal(flagFor({ start: 5, end: 5 }, [placed(0, 5)])?.reason, 'r');
  assert.equal(flagFor({ start: 5, end: 5 }, [placed(6, 9)]), undefined);
});

test('nextFlagged leads with must-type, then worth-typing, and leaves the rest to the caller', () => {
  const baseline = 'a\nb\nc\nd\n';
  const current = 'A\nb\nC\nd\nE\n';
  const sections = buildSections(baseline, current);
  assert.equal(sections.length, 3);
  const [first, second, third] = sections;
  const flags = [
    placed(third.start, third.end, { importance: 'worth-typing' }),
    placed(second.start, second.end),
  ];
  assert.equal(nextFlagged(sections, flags), second);
  second.outcome = 'typed';
  assert.equal(nextFlagged(sections, flags), third);
  third.outcome = 'typed';
  assert.equal(nextFlagged(sections, flags), undefined);
  assert.equal(first.outcome, undefined);
});

test('nextFlagged wraps around to a flagged section behind the offset', () => {
  const sections = buildSections('a\nb\nc\n', 'A\nb\nC\n');
  const [first, second] = sections as [Section, Section];
  assert.equal(nextFlagged(sections, [placed(first.start, first.end)], second.end), first);
});
