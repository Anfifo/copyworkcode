import { strict as assert } from 'assert';
import { test } from 'node:test';
import {
  Section,
  TextChange,
  buildSections,
  claimedCount,
  enclosingSection,
  nearestUnclaimed,
  nextUnclaimed,
  outcomeCounts,
  remapSections,
  sectionAt,
  seedSections,
  typedBoundary,
} from '../src/core/sections';

/** Apply the same changes the remapper is told about, to get the "after" text. */
function applyChanges(text: string, changes: readonly TextChange[]): string {
  let out = text;
  for (const change of [...changes].sort((a, b) => b.from - a.from)) {
    out = out.slice(0, change.from) + change.text + out.slice(change.to);
  }
  return out;
}

/** Remap against changes and assert the target/offset invariant survived. */
function remap(
  sections: Section[],
  before: string,
  changes: readonly TextChange[]
): string {
  const after = applyChanges(before, changes);
  remapSections(sections, changes, after);
  let floor = 0;
  for (const section of sections) {
    assert.ok(section.start <= section.end, 'section stays non-inverted');
    assert.ok(section.end <= after.length, 'section stays inside the document');
    assert.ok(section.start >= floor, 'sections stay disjoint and in order');
    floor = section.end;
    if (section.kind === 'type') {
      assert.equal(
        section.target,
        after.slice(section.start, section.end),
        'target still matches the document text it points at'
      );
      assert.ok(
        section.position <= section.target.length,
        'position stays inside the target'
      );
    }
  }
  return after;
}

const insert = (at: number, text: string): TextChange => ({
  from: at,
  to: at,
  text,
});
const remove = (from: number, to: number): TextChange => ({ from, to, text: '' });
const replace = (from: number, to: number, text: string): TextChange => ({
  from,
  to,
  text,
});

test('buildSections locates an added run by offset', () => {
  const current = 'line1\nline2\nline3\n';
  const sections = buildSections('line1\nline3\n', current);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].kind, 'type');
  assert.equal(sections[0].start, 6);
  assert.equal(sections[0].end, 12);
  assert.equal(sections[0].target, 'line2\n');
  assert.equal(sections[0].target, current.slice(6, 12));
  assert.equal(sections[0].position, 0);
  assert.equal(sections[0].outcome, undefined);
});

test('buildSections treats a whole new file as one section', () => {
  const current = 'created\nby agent\n';
  const sections = buildSections('', current);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].start, 0);
  assert.equal(sections[0].end, current.length);
  assert.equal(sections[0].target, current);
});

test('buildSections marks a deletion-only change as a confirm section', () => {
  const sections = buildSections('keep\ngone\n', 'keep\n');
  assert.equal(sections.length, 1);
  assert.equal(sections[0].kind, 'confirm');
  assert.equal(sections[0].target, '');
  // The text, not a count: a deletion leaves nothing in the file to look at, so
  // this is the only record of what it took.
  assert.deepEqual(sections[0].removedLines, ['gone']);
});

test('buildSections handles a deletion at the end of the file', () => {
  const current = 'keep\n';
  const sections = buildSections('keep\ngone\n', current);
  // The deletion sits past the last line, so the anchor collapses onto the end
  // of the document instead of pointing at a line that is not there.
  assert.equal(sections[0].start, current.length);
  assert.equal(sections[0].end, current.length);
  // No line follows the removal, so its boundary has to be drawn below the
  // last line that survived rather than above the one that took its place.
  assert.equal(sections[0].removedAtEnd, true);
});

test('buildSections flags a mid-file deletion as not at the end', () => {
  const sections = buildSections('a\ngone\nb\n', 'a\nb\n');
  assert.equal(sections[0].kind, 'confirm');
  assert.equal(sections[0].removedAtEnd, false);
});

test('buildSections records the removed lines a replacement swallowed', () => {
  const sections = buildSections('a\nold\nb\n', 'a\nnew\nb\n');
  assert.equal(sections.length, 1);
  assert.equal(sections[0].kind, 'type');
  assert.equal(sections[0].target, 'new\n');
  // A replacement removes lines too, and they are just as invisible as a
  // deletion-only change unless something says they were there.
  assert.deepEqual(sections[0].removedLines, ['old']);
  assert.equal(sections[0].removedAtEnd, false);
});

test('buildSections keeps CRLF offsets aligned with the raw text', () => {
  const current = 'a\r\nb\r\nc\r\n';
  const sections = buildSections('a\r\nc\r\n', current);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].target, 'b\r\n');
  assert.equal(sections[0].target, current.slice(sections[0].start, sections[0].end));
});

test('buildSections produces several sections in offset order', () => {
  const current = 'a\nnew1\nb\nnew2\nc\n';
  const sections = buildSections('a\nb\nc\n', current);
  assert.equal(sections.length, 2);
  assert.ok(sections[0].start < sections[1].start);
  assert.equal(sections[0].target, 'new1\n');
  assert.equal(sections[1].target, 'new2\n');
});

test('a change before a section shifts it without touching progress', () => {
  const before = 'aaa\nTARGET\nzzz\n';
  const sections = buildSections('aaa\nzzz\n', before);
  const start = sections[0].start;
  sections[0].position = 3;
  sections[0].touched = true;

  remap(sections, before, [insert(0, 'xx')]);

  assert.equal(sections[0].start, start + 2);
  assert.equal(sections[0].position, 3, 'progress is untouched by earlier text');
  assert.equal(sections[0].outcome, undefined);
});

test('a change after a section leaves it alone', () => {
  const before = 'aaa\nTARGET\nzzz\n';
  const sections = buildSections('aaa\nzzz\n', before);
  const { start, end } = sections[0];
  sections[0].position = 4;

  remap(sections, before, [insert(before.length, 'tail\n')]);

  assert.deepEqual(
    [sections[0].start, sections[0].end, sections[0].position],
    [start, end, 4]
  );
});

test('a character the reviewer writes at the position is covered by it', () => {
  const before = 'aaa\nTARGET\n';
  const sections = buildSections('aaa\n', before);
  sections[0].position = 3; // "TAR" claimed

  // With editing enabled the reviewer writes "x" where the target wanted "G":
  // the character lands in the buffer, the section grows to cover it, and the
  // position steps over it — remapping alone has to do that, or the character
  // they just wrote would stay marked as text they still owe.
  remap(sections, before, [insert(sections[0].start + 3, 'x')]);

  assert.equal(sections[0].target, 'TARxGET\n');
  assert.equal(sections[0].position, 4);
});

test('a character typed ahead of the position leaves the position alone', () => {
  const before = 'aaa\nTARGET\n';
  const sections = buildSections('aaa\n', before);
  sections[0].position = 2;

  remap(sections, before, [insert(sections[0].start + 5, 'x')]);

  assert.equal(sections[0].target, 'TARGExT\n');
  assert.equal(sections[0].position, 2);
});

test('an edit inside text already typed rewinds the position to the edit', () => {
  const before = 'aaa\nTARGET\n';
  const sections = buildSections('aaa\n', before);
  sections[0].position = 6; // all of "TARGET" claimed

  // Something rewrote a character the reviewer had already covered: everything
  // from there on is unreviewed again.
  remap(sections, before, [replace(sections[0].start + 2, sections[0].start + 3, 'Z')]);

  assert.equal(sections[0].target, 'TAZGET\n');
  assert.equal(sections[0].position, 2, 'progress rewinds to the edit point');
});

test('backspace at the typing position gives back exactly one character', () => {
  const before = 'aaa\nTARGET\n';
  const sections = buildSections('aaa\n', before);
  sections[0].position = 3;
  const boundary = typedBoundary(sections[0]);

  remap(sections, before, [remove(boundary - 1, boundary)]);

  assert.equal(sections[0].target, 'TAGET\n');
  assert.equal(sections[0].position, 2);
  assert.equal(sections[0].outcome, undefined, 'erasing is not diverging');
});

test('backspace at a section start eats context and keeps the section intact', () => {
  const before = 'aaa\nTARGET\n';
  const sections = buildSections('aaa\n', before);
  const start = sections[0].start;

  remap(sections, before, [remove(start - 1, start)]);

  assert.equal(sections[0].start, start - 1);
  assert.equal(sections[0].target, 'TARGET\n');
  assert.equal(sections[0].position, 0);
});

test('a section edited away entirely is claimed as edited', () => {
  const before = 'aaa\nTARGET\nzzz\n';
  const sections = buildSections('aaa\nzzz\n', before);
  const { start, end } = sections[0];

  remap(sections, before, [remove(start, end)]);

  assert.equal(sections[0].target, '');
  assert.equal(sections[0].outcome, 'edited');
  assert.equal(sections[0].free, true);
  assert.equal(claimedCount(sections), 1);
});

test('a section rewritten wholesale covers the replacement, unreviewed', () => {
  const before = 'aaa\nTARGET\nzzz\n';
  const sections = buildSections('aaa\nzzz\n', before);
  const { start, end } = sections[0];
  sections[0].position = 4;
  sections[0].touched = true;

  remap(sections, before, [replace(start, end, 'REWRITTEN\n')]);

  assert.equal(sections[0].target, 'REWRITTEN\n');
  assert.equal(sections[0].position, 0, 'the replacement is nobody’s work yet');
  assert.equal(sections[0].outcome, undefined, 'still owed a review');
});

test('a claimed section that is edited away keeps its original outcome', () => {
  const before = 'aaa\nTARGET\nzzz\n';
  const sections = buildSections('aaa\nzzz\n', before);
  sections[0].outcome = 'typed';
  const { start, end } = sections[0];

  remap(sections, before, [remove(start, end)]);

  assert.equal(sections[0].outcome, 'typed', 'history is not rewritten');
});

test('a confirm section is never auto-claimed, even at the end of the file', () => {
  const before = 'keep\n';
  const sections = buildSections('keep\ngone\n', before);
  assert.equal(sections[0].start, sections[0].end);

  remap(sections, before, [insert(0, 'x')]);

  assert.equal(sections[0].outcome, undefined);
  assert.equal(sections[0].kind, 'confirm');
});

test('a confirm anchor shifts with the text before it', () => {
  const before = 'keep\nstay\n';
  const sections = buildSections('keep\ngone\nstay\n', before);
  const confirm = sections.find((s) => s.kind === 'confirm');
  assert.ok(confirm);
  const start = confirm.start;

  remap(sections, before, [insert(0, 'yy')]);

  assert.equal(confirm.start, start + 2);
});

test('several sections all move under one batch of changes', () => {
  const before = 'a\nnew1\nb\nnew2\nc\n';
  const sections = buildSections('a\nb\nc\n', before);
  sections[0].position = 2;
  sections[1].position = 1;

  // Two edits in one event, given in the descending order the editor reports
  // multi-cursor changes in.
  const second = sections[1].start;
  const first = sections[0].start;
  remap(sections, before, [insert(second, '..'), insert(first, '--')]);

  assert.equal(sections[0].target, '--new1\n');
  assert.equal(sections[1].target, '..new2\n');
});

test('changes given in ascending order remap the same way', () => {
  const before = 'a\nnew1\nb\nnew2\nc\n';
  const descending = buildSections('a\nb\nc\n', before);
  const ascending = buildSections('a\nb\nc\n', before);
  const changes = [
    insert(descending[0].start, '--'),
    insert(descending[1].start, '..'),
  ];

  remap(descending, before, [...changes].reverse());
  remap(ascending, before, changes);

  assert.deepEqual(
    ascending.map((s) => [s.start, s.end, s.target]),
    descending.map((s) => [s.start, s.end, s.target])
  );
});

test('a change spanning a section boundary leaves the two disjoint', () => {
  const before = 'a\nnew1\nb\nnew2\nc\n';
  const sections = buildSections('a\nb\nc\n', before);
  sections[0].position = 2;

  // Select from inside the first section into the second and type over both.
  // One owner per character is the rule: the earlier section keeps the
  // replacement, the later one keeps whatever of its own text survived.
  const after = remap(sections, before, [
    replace(sections[0].start + 1, sections[1].start + 2, 'MERGED'),
  ]);

  assert.equal(after, 'a\nnMERGEDw2\nc\n');
  assert.ok(sections[0].target.includes('MERGED'));
  assert.equal(sections[0].end, sections[1].start, 'they meet, they do not overlap');
});

test('sectionAt finds the unclaimed section under the cursor', () => {
  const before = 'a\nnew1\nb\nnew2\nc\n';
  const sections = buildSections('a\nb\nc\n', before);

  assert.equal(sectionAt(sections, sections[0].start), sections[0]);
  assert.equal(sectionAt(sections, sections[0].end - 1), sections[0]);
  assert.equal(sectionAt(sections, sections[1].start), sections[1]);
  assert.equal(sectionAt(sections, 0), undefined, 'context is not a section');

  sections[0].outcome = 'typed';
  assert.equal(
    sectionAt(sections, sections[0].start),
    undefined,
    'a claimed section stops being the active one'
  );
});

test('nearestUnclaimed picks the closest open section, ahead on a tie', () => {
  const sections = buildSections('a\nb\nc\nd\n', 'a\nnew1\nb\nc\nnew2\nd\n');
  const [first, second] = sections;
  assert.equal(nearestUnclaimed(sections, 0), first, 'context before the first');
  assert.equal(nearestUnclaimed(sections, first.start + 1), first, 'inside is distance zero');
  assert.equal(nearestUnclaimed(sections, second.end + 2), second, 'context after the last');
  // 'b\nc\n' sits between them; the midpoint is equally far from both.
  const gap = second.start - first.end;
  assert.equal(gap % 2, 0);
  assert.equal(nearestUnclaimed(sections, first.end + gap / 2), second, 'tie goes ahead');
  assert.equal(nearestUnclaimed(sections, first.end + gap / 2 - 1), first);

  first.outcome = 'typed';
  assert.equal(nearestUnclaimed(sections, 0), second, 'a claimed section is not a place');
  second.free = true;
  assert.equal(nearestUnclaimed(sections, 0), undefined, 'nor is one with nothing left');
});

test('sectionAt prefers the section a boundary offset starts', () => {
  // Two sections back to back: the cursor at the seam should pick the one it
  // can start typing in, not the one it just left.
  const sections = buildSections('a\n', 'a\nx\ny\n');
  const one: Section[] = [
    { ...sections[0], start: 2, end: 4, target: 'x\n' },
    { ...sections[0], start: 4, end: 6, target: 'y\n' },
  ];
  assert.equal(sectionAt(one, 4), one[1]);
});

test('sectionAt reaches a section that ends at the end of the document', () => {
  const current = 'a\ntail';
  const sections = buildSections('a\n', current);
  assert.equal(sections[0].end, current.length);
  assert.equal(sectionAt(sections, current.length), sections[0]);
});

test('enclosingSection also reports claimed sections', () => {
  const sections = buildSections('a\n', 'a\nx\n');
  sections[0].outcome = 'edited';
  assert.equal(sectionAt(sections, sections[0].start), undefined);
  assert.equal(enclosingSection(sections, sections[0].start), sections[0]);
});

test('nextUnclaimed walks forward and wraps around', () => {
  const before = 'a\nnew1\nb\nnew2\nc\nnew3\n';
  const sections = buildSections('a\nb\nc\n', before);
  assert.equal(sections.length, 3);

  assert.equal(nextUnclaimed(sections, 0), sections[0]);
  assert.equal(nextUnclaimed(sections, sections[0].end), sections[1]);

  sections[1].outcome = 'typed';
  assert.equal(
    nextUnclaimed(sections, sections[0].end),
    sections[2],
    'a claimed section is stepped over'
  );

  sections[2].outcome = 'skipped';
  assert.equal(
    nextUnclaimed(sections, sections[2].end),
    sections[0],
    'past the last one, it wraps to the first still open'
  );

  sections[0].outcome = 'typed';
  assert.equal(nextUnclaimed(sections, 0), undefined, 'nothing left');
});

test('outcomeCounts tallies every kind of claim', () => {
  const sections = buildSections('a\nb\nc\nd\n', 'a\n1\nb\n2\nc\n3\nd\n4\n');
  assert.equal(sections.length, 4);
  sections[0].outcome = 'typed';
  sections[1].outcome = 'skipped';
  sections[2].outcome = 'edited';
  sections[3].outcome = 'confirmed';
  assert.deepEqual(outcomeCounts(sections), {
    typed: 1,
    skipped: 1,
    confirmed: 1,
    edited: 1,
  });
  assert.equal(claimedCount(sections), 4);
});

test('the invariant survives a long run of arbitrary edits', () => {
  // Deterministic pseudo-random edits: the point is that no sequence of buffer
  // changes can leave a section pointing at text it does not describe, which is
  // what every decoration and every keystroke check depends on.
  let seed = 12345;
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };

  let text = 'zero\none\ntwo\nthree\nfour\nfive\nsix\n';
  const sections = buildSections('zero\ntwo\nfour\nsix\n', text);
  assert.ok(sections.length >= 2);

  for (let step = 0; step < 400; step++) {
    const from = rand(text.length + 1);
    const to = Math.min(text.length, from + rand(6));
    const inserted = ['', 'q', 'ab\n', '\n', 'longer text'][rand(5)];
    const changes = [replace(from, to, inserted)];
    text = remap(sections, text, changes);
  }
  assert.ok(text.length > 0);
});


// --- taking another surface's progress --------------------------------------

test('a seed puts back what another surface covered, region by region', () => {
  const sections = buildSections('a\nb\nc\n', 'a\nCHANGED\nc\nADDED\n');
  assert.equal(sections.length, 2);

  const took = seedSections(sections, [
    { position: 4, touched: true },
    { position: 6, touched: false, outcome: 'skipped' },
  ]);

  assert.equal(took, true);
  assert.deepEqual(
    sections.map((s) => [s.position, s.touched, s.outcome]),
    [
      [4, true, undefined],
      [6, false, 'skipped'],
    ]
  );
});

test('a position counted without carriage returns lands past them', () => {
  // The page normalizes line endings and a buffer cannot, so a CRLF line is one
  // character shorter there than here. Six normalized characters is
  // o-n-e-break-t-w, which is seven characters of a target holding both halves
  // of every break.
  const sections = buildSections('', 'one\r\ntwo\r\n');
  assert.equal(sections.length, 1);
  assert.equal(sections[0].target, 'one\r\ntwo\r\n');

  seedSections(sections, [{ position: 6, touched: true }]);

  assert.equal(sections[0].position, 7);
  assert.equal(sections[0].target.slice(0, 7), 'one\r\ntw');
});

test('a seed of the wrong shape is refused whole rather than fitted', () => {
  // The file moved on since the other surface read it, so the seed's positions
  // describe regions this set does not have. None of them is salvageable.
  const sections = buildSections('a\nb\nc\n', 'a\nCHANGED\nc\nADDED\n');

  const took = seedSections(sections, [{ position: 4, touched: true }]);

  assert.equal(took, false);
  assert.deepEqual(
    sections.map((s) => [s.position, s.touched, s.outcome]),
    [
      [0, false, undefined],
      [0, false, undefined],
    ]
  );
});

test('a seeded position never runs past the region it belongs to', () => {
  const sections = buildSections('a\n', 'a\nADDED\n');

  seedSections(sections, [{ position: 999, touched: true }]);

  assert.equal(sections[0].position, sections[0].target.length);
});
