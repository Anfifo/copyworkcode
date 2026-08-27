import { strict as assert } from 'assert';
import { test } from 'node:test';
import { buildFileView } from '../src/core/changeSet';
import {
  ChangeSetReview,
  Outbound,
  RegionGesture,
  ReviewFile,
  SectionState,
} from '../src/core/changeSetReview';

/** A file of `n` numbered lines, so a line's text names its own number. */
function file(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
}

/** One file's document plus fresh progress, the way the panel builds it. */
function loaded(name: string, baseline: string, current: string): ReviewFile {
  const view = buildFileView(name, name.replace('/w/', ''), baseline, current);
  const sections = view.blocks.flatMap((block) =>
    block.kind === 'section' ? [block.section] : []
  );
  return {
    view,
    current,
    sections,
    states: sections.map(() => ({ position: 0, touched: false })),
  };
}

function reviewOf(...files: ReviewFile[]): ChangeSetReview {
  const review = new ChangeSetReview();
  review.load(files);
  return review;
}

/**
 * One file with one changed line, the everyday case: `changed 10\n` is what the
 * region owes, eleven characters of it.
 */
function oneChange(name = '/w/a.ts'): ReviewFile {
  const baseline = file(20);
  return loaded(name, baseline, baseline.replace('line 10', 'changed 10'));
}

/** A file whose only change is a line taken away — nothing to type. */
function oneDeletion(name = '/w/a.ts'): ReviewFile {
  const baseline = file(20);
  return loaded(name, baseline, baseline.replace('line 10\n', ''));
}

/**
 * Run a gesture the way the panel does: resolve, hand the file over if the
 * resolution asks for it, commit. `between` stands in for whatever can happen
 * while that handover is awaited.
 */
function play(
  review: ChangeSetReview,
  gesture: RegionGesture,
  between?: () => void
): { posts: Outbound[]; finished?: ReturnType<ChangeSetReview['commit']> } {
  const resolution = review.resolve(gesture);
  if (resolution.kind === 'ignore') return { posts: [] };
  if (resolution.kind === 'reject') return { posts: resolution.posts };
  if (resolution.takesOver) review.takeOver(gesture.file);
  if (between) between();
  const commit = review.commit(resolution);
  return { posts: commit?.posts ?? [], finished: commit };
}

/** Type every visible character of a region: whitespace snaps on its own. */
function typeAll(review: ChangeSetReview, name: string, index: number, text: string) {
  let last: ReturnType<typeof play> = { posts: [] };
  for (const key of text) {
    last = play(review, { type: 'type', file: name, index, text: key });
  }
  return last;
}

function stateOf(review: ChangeSetReview, name: string, index = 0): SectionState {
  const live = review.fileAt(name);
  assert.ok(live);
  return live.states[index];
}

test('a matched keystroke advances the region and says where it got to', () => {
  const review = reviewOf(oneChange());

  const { posts } = play(review, { type: 'type', file: '/w/a.ts', index: 0, text: 'c' });

  assert.deepEqual(posts, [
    {
      type: 'section',
      file: '/w/a.ts',
      index: 0,
      state: { position: 1, touched: true },
    },
  ]);
  assert.equal(stateOf(review, '/w/a.ts').position, 1);
});

test('a key the region does not owe changes nothing and takes no file over', () => {
  const review = reviewOf(oneChange());

  const resolution = review.resolve({
    type: 'type',
    file: '/w/a.ts',
    index: 0,
    text: 'z',
  });

  // The resolution has nowhere to say it took anything over, which is the point:
  // a wrong key must not be what ends a review running in an editor.
  assert.deepEqual(resolution, {
    kind: 'reject',
    posts: [{ type: 'reject', file: '/w/a.ts', index: 0 }],
  });
  assert.equal(review.owns('/w/a.ts'), false);
  assert.deepEqual(stateOf(review, '/w/a.ts'), { position: 0, touched: false });
});

test('the first gesture that lands asks for the file, and only the first', () => {
  const review = reviewOf(oneChange());
  const first = review.resolve({ type: 'type', file: '/w/a.ts', index: 0, text: 'c' });

  assert.ok(first.kind === 'apply' && first.takesOver);
  review.takeOver('/w/a.ts');
  review.commit(first);

  const second = review.resolve({ type: 'type', file: '/w/a.ts', index: 0, text: 'h' });
  assert.ok(second.kind === 'apply');
  assert.equal(second.takesOver, false);
});

test('typing the last character of a region claims it as typed', () => {
  const review = reviewOf(oneChange());

  // Ten visible characters; the newline behind them snaps on its own.
  const last = typeAll(review, '/w/a.ts', 0, 'changed 10');

  assert.deepEqual(stateOf(review, '/w/a.ts'), {
    position: 11,
    touched: true,
    outcome: 'typed',
  });
  assert.equal(last.finished?.finished?.counts.typed, 1);
});

test('skipping a region fills it and records it as skipped, typing or not', () => {
  const review = reviewOf(oneChange());
  play(review, { type: 'type', file: '/w/a.ts', index: 0, text: 'c' });

  play(review, { type: 'skip', file: '/w/a.ts', index: 0 });

  // Filling the rest is not typing it, whatever was typed before.
  assert.deepEqual(stateOf(review, '/w/a.ts'), {
    position: 11,
    touched: false,
    outcome: 'skipped',
  });
});

test('a fill advances without claiming, and a region a keystroke touched is typed', () => {
  const review = reviewOf(oneChange());

  play(review, { type: 'fillWord', file: '/w/a.ts', index: 0 });
  assert.deepEqual(stateOf(review, '/w/a.ts'), { position: 7, touched: false });

  play(review, { type: 'type', file: '/w/a.ts', index: 0, text: ' ' });
  play(review, { type: 'fillLine', file: '/w/a.ts', index: 0 });

  // The line was finished by a fill, but a keystroke was matched here, so this
  // is a region the reviewer went through rather than one they waved past.
  assert.deepEqual(stateOf(review, '/w/a.ts'), {
    position: 11,
    touched: true,
    outcome: 'typed',
  });
});

test('a deletion is claimed by acknowledging it, whichever gesture arrives', () => {
  for (const gesture of ['confirm', 'skip', 'fillLine'] as const) {
    const review = reviewOf(oneDeletion());

    play(review, { type: gesture, file: '/w/a.ts', index: 0 });

    // The editor review reads all three the same way: there is nothing to type,
    // so any of them is the acknowledgement.
    assert.equal(stateOf(review, '/w/a.ts').outcome, 'confirmed', gesture);
  }
});

test('a gesture aimed at a claimed region, an unknown file or no region is ignored', () => {
  const review = reviewOf(oneChange());
  typeAll(review, '/w/a.ts', 0, 'changed 10');

  for (const gesture of [
    { type: 'type', file: '/w/a.ts', index: 0, text: 'c' },
    { type: 'type', file: '/w/gone.ts', index: 0, text: 'c' },
    { type: 'skip', file: '/w/a.ts', index: 9 },
  ] as RegionGesture[]) {
    assert.deepEqual(review.resolve(gesture), { kind: 'ignore' });
  }
});

test('the last region claimed finishes the file, with what the page read', () => {
  const live = oneChange();
  const review = reviewOf(live);

  const commit = typeAll(review, '/w/a.ts', 0, 'changed 10').finished;

  assert.ok(commit?.finished);
  assert.deepEqual(commit.finished.counts, {
    typed: 1,
    skipped: 0,
    confirmed: 0,
    edited: 0,
  });
  assert.equal(commit.finished.outcome, 'typed');
  assert.equal(commit.finished.summary, '1 typed, 0 skipped');
  // The baseline advances to what was actually read, not to whatever is on disk
  // by now — anything that landed since comes back as debt, which is the truth.
  assert.equal(commit.finished.content, live.current);
  assert.deepEqual(commit.posts[commit.posts.length - 1], {
    type: 'done',
    file: '/w/a.ts',
    summary: '1 typed, 0 skipped',
  });
  // The file is finished, so the page has no further claim on it.
  assert.equal(review.owns('/w/a.ts'), false);
});

test('a file skipped through end to end is recorded as skipped', () => {
  const baseline = file(30);
  const current = baseline
    .replace('line 10', 'changed 10')
    .replace('line 25', 'changed 25');
  const review = reviewOf(loaded('/w/a.ts', baseline, current));

  play(review, { type: 'skip', file: '/w/a.ts', index: 0 });
  const commit = play(review, { type: 'skip', file: '/w/a.ts', index: 1 }).finished;

  assert.equal(commit?.finished?.outcome, 'skipped');
  assert.equal(commit?.finished?.summary, '0 typed, 2 skipped');
});

test('a deletion acknowledged counts as a review that happened', () => {
  const review = reviewOf(oneDeletion());

  const commit = play(review, { type: 'confirm', file: '/w/a.ts', index: 0 }).finished;

  assert.equal(commit?.finished?.outcome, 'typed');
  assert.equal(
    commit?.finished?.summary,
    '0 typed, 0 skipped, 1 deletion(s) confirmed'
  );
});

test('a file finishes only once, however many regions it had', () => {
  const baseline = file(30);
  const current = baseline
    .replace('line 10', 'changed 10')
    .replace('line 25', 'changed 25');
  const review = reviewOf(loaded('/w/a.ts', baseline, current));

  const first = play(review, { type: 'skip', file: '/w/a.ts', index: 0 }).finished;
  assert.equal(first?.finished, undefined);
  const second = play(review, { type: 'skip', file: '/w/a.ts', index: 1 }).finished;
  assert.ok(second?.finished);
});

test('one file finishing leaves the rest of the page alone', () => {
  const review = reviewOf(oneChange('/w/a.ts'), oneChange('/w/b.ts'));

  typeAll(review, '/w/a.ts', 0, 'changed 10');

  assert.deepEqual(stateOf(review, '/w/b.ts'), { position: 0, touched: false });
  assert.equal(review.size, 2);
});

test('a keystroke lands nowhere once an editor review has taken the file', () => {
  const review = reviewOf(oneChange());

  // Nothing had been typed here, so there is no progress for the handover to
  // give up — the page simply stops being this file's surface, and the keystroke
  // that was in flight has nowhere to land.
  const posts = play(review, { type: 'type', file: '/w/a.ts', index: 0, text: 'c' }, () =>
    review.dropFile('/w/a.ts')
  ).posts;

  assert.deepEqual(posts, []);
  assert.deepEqual(stateOf(review, '/w/a.ts'), { position: 0, touched: false });
});

test('a keystroke aimed at progress that was given up lands nowhere', () => {
  const review = reviewOf(oneChange());
  play(review, { type: 'type', file: '/w/a.ts', index: 0, text: 'c' });

  const posts = play(review, { type: 'type', file: '/w/a.ts', index: 0, text: 'h' }, () =>
    review.dropFile('/w/a.ts')
  ).posts;

  assert.deepEqual(posts, []);
  assert.deepEqual(stateOf(review, '/w/a.ts'), { position: 0, touched: false });
});

test('a resolution is never applied to progress it was not worked out against', () => {
  const review = reviewOf(oneChange());
  play(review, { type: 'type', file: '/w/a.ts', index: 0, text: 'c' });
  const inFlight = review.resolve({
    type: 'type',
    file: '/w/a.ts',
    index: 0,
    text: 'h',
  });

  // The file goes to an editor review and comes back to the page while this
  // keystroke is still in the air. The page owns it again, so ownership says
  // nothing — but the progress the keystroke was worked out against is gone.
  review.dropFile('/w/a.ts');
  review.takeOver('/w/a.ts');

  assert.equal(review.commit(inFlight), undefined);
  assert.deepEqual(stateOf(review, '/w/a.ts'), { position: 0, touched: false });
});

test('giving a file up owes its regions again, and says so once', () => {
  const review = reviewOf(oneChange());
  play(review, { type: 'type', file: '/w/a.ts', index: 0, text: 'c' });

  assert.deepEqual(review.dropFile('/w/a.ts'), {
    type: 'file',
    file: '/w/a.ts',
    states: [{ position: 0, touched: false }],
  });
  // Nothing to give up the second time: the regions are already owed.
  assert.equal(review.dropFile('/w/a.ts'), undefined);
  assert.equal(review.owns('/w/a.ts'), false);
});

test('a file already finished here is not owed again', () => {
  const review = reviewOf(oneChange());
  typeAll(review, '/w/a.ts', 0, 'changed 10');

  // Its baseline moved when it finished. Owing its regions again would be the
  // page contradicting a review that happened.
  assert.equal(review.dropFile('/w/a.ts'), undefined);
  assert.equal(stateOf(review, '/w/a.ts').outcome, 'typed');
});

test('a file nothing has touched is given up without a word', () => {
  const review = reviewOf(oneChange());

  assert.equal(review.dropFile('/w/a.ts'), undefined);
  assert.equal(review.dropFile('/w/never-seen.ts'), undefined);
});

test('a gap is answered from the content the page is reviewing', () => {
  const review = reviewOf(oneChange());

  assert.deepEqual(review.gap('/w/a.ts', 1, 2), {
    type: 'gap',
    file: '/w/a.ts',
    from: 1,
    to: 2,
    lines: [
      { n: 1, text: 'line 1' },
      { n: 2, text: 'line 2' },
    ],
  });
  assert.equal(review.gap('/w/b.ts', 1, 2), undefined);
  assert.equal(review.gap('/w/a.ts', 1, Number.NaN), undefined);
});

test('the document carries every file, its progress and what it is compared against', () => {
  const review = reviewOf(oneChange('/w/a.ts'), oneChange('/w/b.ts'));
  play(review, { type: 'skip', file: '/w/a.ts', index: 0 });

  const set = review.document('the last snapshot');
  assert.ok(set.type === 'set');
  assert.equal(set.baselineLabel, 'the last snapshot');
  assert.deepEqual(
    set.files.map((doc) => [doc.file, doc.states[0].outcome]),
    [
      ['/w/a.ts', 'skipped'],
      ['/w/b.ts', undefined],
    ]
  );
});

test('loading a fresh document drops what the page owned', () => {
  const review = reviewOf(oneChange());
  play(review, { type: 'type', file: '/w/a.ts', index: 0, text: 'c' });
  assert.equal(review.owns('/w/a.ts'), true);

  review.load([oneChange()]);

  assert.equal(review.owns('/w/a.ts'), false);
  assert.deepEqual(stateOf(review, '/w/a.ts'), { position: 0, touched: false });
});

test('the queue is told nothing about a file the page has only drawn', () => {
  const review = reviewOf(oneChange());

  // Every file in the change set is on the page. Reporting all of them would
  // put a reading on every row in the queue that says only "the page is open".
  assert.equal(review.progressFor('/w/a.ts'), undefined);
  assert.equal(review.owns('/w/a.ts'), false);
});

test('coverage is reported from the first gesture that takes a file over', () => {
  const baseline = file(30);
  const current = baseline
    .replace('line 10', 'changed 10')
    .replace('line 25', 'changed 25');
  const review = reviewOf(loaded('/w/a.ts', baseline, current));

  // One character in: nothing is claimed yet, but the page is this file's
  // surface now and the row has something true to say about where it is.
  play(review, { type: 'type', file: '/w/a.ts', index: 0, text: 'c' });
  assert.deepEqual(review.progressFor('/w/a.ts'), { claimed: 0, total: 2 });

  play(review, { type: 'skip', file: '/w/a.ts', index: 0 });
  assert.deepEqual(review.progressFor('/w/a.ts'), { claimed: 1, total: 2 });
});

test('a file finished on the page stops reporting progress', () => {
  const baseline = file(30);
  const current = baseline
    .replace('line 10', 'changed 10')
    .replace('line 25', 'changed 25');
  const review = reviewOf(loaded('/w/a.ts', baseline, current));

  play(review, { type: 'skip', file: '/w/a.ts', index: 0 });
  play(review, { type: 'skip', file: '/w/a.ts', index: 1 });

  // Its baseline moved when it closed, so the row left the queue. Debt standing
  // against the file again is a new change this page has not read, and "9/9" is
  // the one answer that would be a lie about it.
  assert.equal(review.progressFor('/w/a.ts'), undefined);
});

test('a file given up to an editor stops reporting progress', () => {
  const baseline = file(30);
  const current = baseline
    .replace('line 10', 'changed 10')
    .replace('line 25', 'changed 25');
  const review = reviewOf(loaded('/w/a.ts', baseline, current));

  play(review, { type: 'skip', file: '/w/a.ts', index: 0 });
  assert.deepEqual(review.progressFor('/w/a.ts'), { claimed: 1, total: 2 });

  review.dropFile('/w/a.ts');
  assert.equal(review.progressFor('/w/a.ts'), undefined);
});

test('a page that has been cleared reports nothing for anything', () => {
  const review = reviewOf(oneChange());
  play(review, { type: 'type', file: '/w/a.ts', index: 0, text: 'c' });
  assert.deepEqual(review.progressFor('/w/a.ts'), { claimed: 0, total: 1 });

  review.clear();
  assert.equal(review.progressFor('/w/a.ts'), undefined);
  assert.equal(review.progressFor('/w/never-seen.ts'), undefined);
});

test('the page knows whether any row is reading from it', () => {
  const review = reviewOf(oneChange());
  assert.equal(review.reported, false, 'a page nothing has touched is on no row');

  play(review, { type: 'type', file: '/w/a.ts', index: 0, text: 'c' });
  assert.equal(review.reported, true);

  // Finishing takes the file off the queue with it, so there is nothing left
  // for a row to read even though the page still holds the file.
  typeAll(review, '/w/a.ts', 0, 'hanged 10');
  assert.equal(review.reported, false);
});
