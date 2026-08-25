import { strict as assert } from 'assert';
import { test } from 'node:test';
import { ViewBlock, buildFileView, sliceLines } from '../src/core/changeSet';

/** A file of `n` numbered lines, so a line's text names its own number. */
function file(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
}

/** The block run as one compact string, to assert layout in one line. */
function shape(blocks: readonly ViewBlock[]): string {
  return blocks
    .map((block) => {
      if (block.kind === 'gap') return `gap ${block.from}-${block.to}`;
      if (block.kind === 'context') {
        const lines = block.lines;
        return `ctx ${lines[0].n}-${lines[lines.length - 1].n}`;
      }
      const s = block.section;
      return `${s.kind} ${s.line} +${s.addedLines.length} -${s.removedLines.length}`;
    })
    .join(' | ');
}

function view(baseline: string, current: string, context?: number) {
  return buildFileView('/w/a.ts', 'a.ts', baseline, current, context);
}

test('a file with no debt has no blocks', () => {
  const both = file(10);
  assert.deepEqual(view(both, both).blocks, []);
});

test('one changed run is surrounded by context and framed by gaps', () => {
  const baseline = file(20);
  const current = baseline.replace('line 10', 'changed 10');

  const v = view(baseline, current);
  assert.equal(shape(v.blocks), 'gap 1-6 | ctx 7-9 | type 10 +1 -1 | ctx 11-13 | gap 14-21');
  assert.equal(v.addedLines, 1);
  assert.equal(v.removedLines, 1);
  assert.equal(v.isNew, false);
});

test('context carries the real text, numbered as the editor numbers it', () => {
  const baseline = file(20);
  const current = baseline.replace('line 10', 'changed 10');

  const blocks = view(baseline, current).blocks;
  const above = blocks.find((b) => b.kind === 'context');
  assert.ok(above && above.kind === 'context');
  assert.deepEqual(above.lines, [
    { n: 7, text: 'line 7' },
    { n: 8, text: 'line 8' },
    { n: 9, text: 'line 9' },
  ]);
});

test('added lines carry their own line numbers', () => {
  const baseline = file(20);
  const current = baseline.replace('line 10\n', 'line 10\nadded a\nadded b\n');

  const blocks = view(baseline, current).blocks;
  const section = blocks.find((b) => b.kind === 'section');
  assert.ok(section && section.kind === 'section');
  assert.deepEqual(section.section.addedLines, [
    { n: 11, text: 'added a' },
    { n: 12, text: 'added b' },
  ]);
});

test('a hole too small to be worth a control is shown instead of hidden', () => {
  const baseline = file(30);
  // Seven lines apart: the two context runs meet with one line to spare.
  const current = baseline.replace('line 10', 'changed 10').replace('line 17', 'changed 17');

  assert.equal(
    shape(view(baseline, current).blocks),
    'gap 1-6 | ctx 7-9 | type 10 +1 -1 | ctx 11-16 | type 17 +1 -1 | ctx 18-20 | gap 21-31'
  );
});

test('a hole worth a control keeps one', () => {
  const baseline = file(40);
  const current = baseline.replace('line 10', 'changed 10').replace('line 30', 'changed 30');

  assert.equal(
    shape(view(baseline, current).blocks),
    'gap 1-6 | ctx 7-9 | type 10 +1 -1 | ctx 11-13 | gap 14-26 | ctx 27-29 | ' +
      'type 30 +1 -1 | ctx 31-33 | gap 34-41'
  );
});

test('a deletion is anchored at the line that took its place, once', () => {
  const baseline = file(20);
  const current = baseline.replace('line 10\n', '');

  const blocks = view(baseline, current).blocks;
  // Line 10 of the current file is old line 11 — the deletion's anchor. It
  // belongs to the section and must not also appear as context.
  assert.equal(shape(blocks), 'gap 1-6 | ctx 7-9 | confirm 10 +0 -1 | ctx 11-13 | gap 14-20');
  const section = blocks.find((b) => b.kind === 'section');
  assert.ok(section && section.kind === 'section');
  assert.deepEqual(section.section.removedLines, ['line 10']);
  assert.equal(section.section.removedAtEnd, false);
  assert.equal(section.section.target, '');
});

test('a deletion off the end of the file says so', () => {
  const baseline = file(10);
  const current = file(8);

  const blocks = view(baseline, current).blocks;
  const section = blocks.find((b) => b.kind === 'section');
  assert.ok(section && section.kind === 'section');
  assert.equal(section.section.removedAtEnd, true);
  assert.deepEqual(section.section.removedLines, ['line 9', 'line 10']);
});

test('a removal off the end is anchored on the line the newline opens', () => {
  const baseline = file(10);
  const current = file(8);

  // The file ends in a newline, so the editor has an empty ninth line sitting
  // exactly where the removed text was — and that is the only line a removal
  // there can be drawn against. Counting lines the way the diff does would
  // leave it out and lose the section altogether.
  const v = view(baseline, current);
  assert.equal(v.totalLines, 9);
  assert.equal(shape(v.blocks), 'gap 1-5 | ctx 6-8 | confirm 9 +0 -2');
});

test('a new file is one section over the whole content', () => {
  const v = view('', file(4));

  assert.equal(v.isNew, true);
  assert.equal(shape(v.blocks), 'type 1 +4 -0 | ctx 5-5');
  assert.equal(v.addedLines, 4);
});

test('sliceLines answers a gap, clamped to the file', () => {
  const current = file(10);

  assert.deepEqual(sliceLines(current, 2, 3), [
    { n: 2, text: 'line 2' },
    { n: 3, text: 'line 3' },
  ]);
  assert.deepEqual(sliceLines(current, 0, 1), [{ n: 1, text: 'line 1' }]);
  assert.equal(sliceLines(current, 9, 99).length, 3);
});

test('regions are numbered by the order they appear in, from zero', () => {
  const baseline = file(40);
  const current = baseline
    .replace('line 5', 'changed 5')
    .replace('line 20', 'changed 20')
    .replace('line 35', 'changed 35');

  // The number is the handle both surfaces address a region by, so it has to be
  // the region's place in the file's set and nothing else.
  const indexes = view(baseline, current)
    .blocks.filter((b) => b.kind === 'section')
    .map((b) => (b.kind === 'section' ? b.section.index : -1));
  assert.deepEqual(indexes, [0, 1, 2]);
});

test('the added lines reconstruct the target, bar its trailing newline', () => {
  const baseline = file(20);
  const current = baseline.replace('line 10\n', 'one\n\nthree\n');

  // A surface drawing the target line by line walks it as text plus one newline
  // per line, so this is what says where a position in the target falls.
  const section = view(baseline, current).blocks.find((b) => b.kind === 'section');
  assert.ok(section && section.kind === 'section');
  const s = section.section;
  assert.deepEqual(
    s.addedLines.map((line) => line.text),
    ['one', '', 'three']
  );
  assert.equal(s.addedLines.map((line) => line.text).join('\n') + '\n', s.target);
});

test('a file written with CRLF draws no carriage returns anywhere', () => {
  // The page writes code into text nodes, where a carriage return is a line
  // break of its own: one left in would draw a phantom blank line under every
  // row of the file. Nothing about the change is carried by it either — the
  // diff normalizes endings before it runs.
  const crlf = (n: number) =>
    Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\r\n') + '\r\n';
  const baseline = crlf(10);
  const current = baseline.replace('line 5', 'changed 5');

  const v = view(baseline, current);
  assert.equal(JSON.stringify(v.blocks).includes('\\r'), false);
  assert.equal(JSON.stringify(sliceLines(current, 1, 2)).includes('\\r'), false);

  const section = v.blocks.find((b) => b.kind === 'section');
  assert.ok(section && section.kind === 'section');
  const s = section.section;
  // The target is normalized with the rest, so the page's one-newline-per-line
  // arithmetic reaches the end of it exactly.
  assert.equal(s.target, 'changed 5\n');
  assert.equal(
    s.addedLines.reduce((n, line) => n + line.text.length + 1, 0),
    s.target.length
  );
});
