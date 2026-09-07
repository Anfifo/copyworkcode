import { strict as assert } from 'assert';
import { test } from 'node:test';
import { buildFileView } from '../src/core/changeSet';
import { ChangeSetReview, ReviewFile } from '../src/core/changeSetReview';
import { FakeElement, Page, loadPage } from './helpers/pageDom';

/**
 * The change set page's own script, run against a document of the shape its HTML
 * provides (see `helpers/pageDom.ts`).
 *
 * Two kinds of check here. Most of it is the page on its own: what it draws from
 * a payload, what it sends when a key is pressed, and how it redraws from what
 * comes back — the page holds no judgement of its own, so those two halves are
 * the whole of it. The last few run the page against the real
 * `ChangeSetReview`, which is the only way to see that the two agree about what
 * a region owes and when it is claimed.
 *
 * Nothing here can say anything about how the page looks. Colour, spacing and
 * whether the caret is where the eye is stay eye-only.
 */

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

/** One changed line in a twenty-line file: `changed 10\n` is what it owes. */
function changedFile(name = '/w/a.ts'): ReviewFile {
  const baseline = file(20);
  return loaded(name, baseline, baseline.replace('line 10', 'changed 10'));
}

/** One line taken away, and nothing to type. */
function deletedLineFile(name = '/w/b.ts'): ReviewFile {
  const baseline = file(20);
  return loaded(name, baseline, baseline.replace('line 5\n', ''));
}

const LABEL = 'the last snapshot';

function reviewOf(...files: ReviewFile[]): ChangeSetReview {
  const review = new ChangeSetReview();
  review.load(files);
  return review;
}

/** A loaded page holding the document these files come to. */
function pageWith(...files: ReviewFile[]): { page: Page; review: ChangeSetReview } {
  const review = reviewOf(...files);
  const page = loadPage();
  page.receive(review.document(LABEL));
  page.sent.length = 0;
  return { page, review };
}

/** The last thing the page sent, or undefined if it sent nothing. */
function lastSent(page: Page): Record<string, unknown> | undefined {
  return page.sent[page.sent.length - 1];
}

const added = (section: FakeElement) =>
  section.querySelector('.added')?.querySelectorAll('.row') ?? [];
const removed = (section: FakeElement) =>
  section.querySelector('.removed')?.querySelectorAll('.row') ?? [];

/** One code row as the reader sees it: its number, and its three text parts. */
function row(node: FakeElement) {
  const text = node.querySelector('.text');
  return {
    n: node.querySelector('.n')?.textContent ?? '',
    covered: text?.querySelector('.covered')?.textContent ?? '',
    owed: text?.querySelector('.owed')?.textContent ?? '',
    caret: text?.querySelector('.caret') !== null && text !== null,
    text: text?.textContent ?? '',
  };
}

/**
 * Run the page against the real review state, the way the panel does: drain what
 * the page sent, resolve each gesture, and post back what comes of it. Returns
 * the files that finished while it drained.
 */
function pump(page: Page, review: ChangeSetReview): string[] {
  const finished: string[] = [];
  const outgoing = page.sent.splice(0, page.sent.length);
  for (const message of outgoing) {
    const type = String(message.type);
    if (type === 'ready' || type === 'reload') {
      page.receive(review.document(LABEL));
      continue;
    }
    if (type === 'expandGap') {
      const lines = review.gap(
        String(message.file),
        Number(message.from),
        Number(message.to)
      );
      if (lines) page.receive(lines);
      continue;
    }
    if (type === 'openInEditor') continue;
    const resolution = review.resolve(message as never);
    if (resolution.kind === 'ignore') continue;
    if (resolution.kind === 'reject') {
      for (const post of resolution.posts) page.receive(post);
      continue;
    }
    if (resolution.takesOver) review.takeOver(String(message.file));
    const commit = review.commit(resolution);
    if (!commit) continue;
    for (const post of commit.posts) page.receive(post);
    if (commit.finished) finished.push(commit.finished.file);
  }
  return finished;
}

// --- what the page sends and draws ------------------------------------------

test('the page asks for the document as soon as it loads', () => {
  const page = loadPage();

  assert.deepEqual(page.sent, [{ type: 'ready' }]);
});

test('a file is drawn with its heading, its context and the code it owes', () => {
  const { page } = pageWith(changedFile());

  const files = page.files();
  assert.equal(files.length, 1);
  assert.equal(files[0].querySelector('.path')?.textContent, 'a.ts');
  assert.equal(files[0].querySelector('.added-count')?.textContent, '+1');
  assert.equal(files[0].querySelector('.removed-count')?.textContent, '−1');

  // gap 1-6 | ctx 7-9 | type 10 | ctx 11-13 | gap 14-21
  assert.equal(files[0].querySelectorAll('.gap').length, 2);
  assert.equal(files[0].querySelectorAll('.context').length, 2);
  const regions = page.regions(files[0]);
  assert.equal(regions.length, 1);
  assert.deepEqual(added(regions[0]).map(row).map((line) => [line.n, line.owed]), [
    ['10', 'changed 10'],
  ]);
  // What the change took away, shown in the place it was. The line is not in
  // the file any more, so its number column holds the mark for gone.
  assert.deepEqual(
    removed(regions[0]).map(row).map((line) => [line.n, line.text]),
    [['−', 'line 10']]
  );
});

test('context carries the surviving code, numbered as the editor numbers it', () => {
  const { page } = pageWith(changedFile());

  const above = page.files()[0].querySelector('.context');
  assert.ok(above);
  assert.deepEqual(
    above.querySelectorAll('.row').map(row).map((line) => [line.n, line.text]),
    [
      ['7', 'line 7'],
      ['8', 'line 8'],
      ['9', 'line 9'],
    ]
  );
});

test('a gap says how much it is holding back', () => {
  const { page } = pageWith(changedFile());

  const gaps = page.files()[0].querySelectorAll('.gap');
  assert.equal(gaps[0].textContent, '⋯ 6 lines unchanged');
  assert.deepEqual([gaps[0].dataset.from, gaps[0].dataset.to], ['1', '6']);
});

test('the first region still owed is where the keystrokes go', () => {
  const { page } = pageWith(changedFile('/w/a.ts'), changedFile('/w/b.ts'));

  const first = page.regions(page.files()[0])[0];
  const second = page.regions(page.files()[1])[0];
  assert.equal(first.classList.contains('active'), true);
  assert.equal(second.classList.contains('active'), false);
  assert.equal(row(added(first)[0]).caret, true);
});

test('code is drawn coloured, and stays coloured either side of the caret', () => {
  const baseline = file(20);
  const { page } = pageWith(
    loaded('/w/a.ts', baseline, baseline.replace('line 10', 'const total = 1;'))
  );
  const region = page.regions(page.files()[0])[0];
  const text = () => added(region)[0].querySelector('.text');

  assert.equal(
    text()?.querySelector('.owed')?.querySelector('.t-keyword')?.textContent,
    'const'
  );
  assert.equal(
    text()?.querySelector('.owed')?.querySelector('.t-number')?.textContent,
    '1'
  );

  // Three characters in, the typing position falls inside the keyword. Both
  // halves of it stay the keyword: colour is per run of code, not per row, and
  // the two halves are drawn from the same runs.
  page.receive({
    type: 'section',
    file: '/w/a.ts',
    index: 0,
    state: { position: 3, touched: true },
  });

  assert.equal(
    text()?.querySelector('.covered')?.querySelector('.t-keyword')?.textContent,
    'con'
  );
  assert.equal(
    text()?.querySelector('.owed')?.querySelector('.t-keyword')?.textContent,
    'st'
  );
  assert.equal(
    row(added(region)[0]).text,
    'const total = 1;',
    'and the row still reads as its own line, character for character'
  );
});

test('a keystroke is sent on, and nothing is decided on the page', () => {
  const { page } = pageWith(changedFile());

  const pressed = page.press('c');

  assert.equal(pressed.defaultPrevented, true);
  assert.deepEqual(lastSent(page), {
    type: 'type',
    file: '/w/a.ts',
    index: 0,
    text: 'c',
  });
  // Nothing moved: the extension owns the matching, so the page waits.
  assert.equal(row(added(page.regions(page.files()[0])[0])[0]).owed, 'changed 10');
});

test('progress that comes back brings the code up to strength behind the caret', () => {
  const { page } = pageWith(changedFile());

  page.receive({
    type: 'section',
    file: '/w/a.ts',
    index: 0,
    state: { position: 3, touched: true },
  });

  const line = row(added(page.regions(page.files()[0])[0])[0]);
  assert.equal(line.covered, 'cha');
  assert.equal(line.owed, 'nged 10');
  assert.equal(line.caret, true);
});

test('the keys the page answers to, and the ones it leaves alone', () => {
  const { page } = pageWith(changedFile());
  const gesture = (stroke: Parameters<Page['press']>[0]) => {
    page.sent.length = 0;
    page.press(stroke);
    return lastSent(page);
  };

  assert.deepEqual(gesture({ key: 'f', altKey: true }), {
    type: 'fillLine',
    file: '/w/a.ts',
    index: 0,
  });
  assert.deepEqual(gesture({ key: 's', altKey: true }), {
    type: 'skip',
    file: '/w/a.ts',
    index: 0,
  });
  assert.equal(String(gesture('Tab')?.type), 'fillWord');
  assert.deepEqual(gesture('Enter'), {
    type: 'type',
    file: '/w/a.ts',
    index: 0,
    text: '\n',
  });
  // AltGr is how a good many layouts reach the characters code is written with,
  // and it arrives as Ctrl+Alt: the page has to type the brace anyway.
  assert.deepEqual(gesture({ key: '{', altGraph: true }), {
    type: 'type',
    file: '/w/a.ts',
    index: 0,
    text: '{',
  });
  // Copying and zooming belong to the reader.
  assert.equal(gesture({ key: 'c', ctrlKey: true }), undefined);
  // Everything else scrolls the page.
  assert.equal(gesture('ArrowDown'), undefined);
  assert.equal(gesture('PageDown'), undefined);
});

test('a deletion asks to be acknowledged, and cannot be typed at', () => {
  const { page } = pageWith(deletedLineFile('/w/b.ts'));

  page.press('x');
  assert.deepEqual(page.sent, []);

  page.press('Enter');
  assert.deepEqual(lastSent(page), { type: 'confirm', file: '/w/b.ts', index: 0 });
});

test('a wrong key is a flash and a word, and nothing else', () => {
  const { page } = pageWith(changedFile());

  page.receive({ type: 'reject', file: '/w/a.ts', index: 0 });

  const region = page.regions(page.files()[0])[0];
  assert.equal(region.classList.contains('wrong'), true);
  assert.match(page.byId('status').textContent, /wrong key/);
  page.runTimers();
  assert.equal(region.classList.contains('wrong'), false);
});

test('claiming the active region moves the caret to the next one owed', () => {
  const { page } = pageWith(changedFile('/w/a.ts'), changedFile('/w/b.ts'));

  page.receive({
    type: 'section',
    file: '/w/a.ts',
    index: 0,
    state: { position: 11, touched: true, outcome: 'typed' },
  });

  const first = page.regions(page.files()[0])[0];
  const second = page.regions(page.files()[1])[0];
  assert.equal(first.classList.contains('claimed'), true);
  assert.equal(first.classList.contains('active'), false);
  assert.equal(second.classList.contains('active'), true);
  // The region says how it was dealt with, in place of its controls.
  assert.equal(first.querySelector('.outcome')?.textContent, 'typed');
});

test('a file given up owes its regions again and loses the caret', () => {
  const { page } = pageWith(changedFile('/w/a.ts'), changedFile('/w/b.ts'));
  page.receive({
    type: 'section',
    file: '/w/a.ts',
    index: 0,
    state: { position: 4, touched: true },
  });

  page.receive({
    type: 'file',
    file: '/w/a.ts',
    states: [{ position: 0, touched: false }],
  });

  const first = page.regions(page.files()[0])[0];
  assert.equal(row(added(first)[0]).covered, '');
  assert.equal(row(added(first)[0]).owed, 'changed 10');
  assert.equal(first.classList.contains('active'), false);
  assert.equal(page.regions(page.files()[1])[0].classList.contains('active'), true);
});

test('a finished file says so in its heading', () => {
  const { page } = pageWith(changedFile());

  page.receive({ type: 'done', file: '/w/a.ts', summary: '1 typed, 0 skipped' });

  const drawn = page.files()[0];
  assert.equal(drawn.classList.contains('done'), true);
  assert.equal(
    drawn.querySelector('.progress')?.textContent,
    'reviewed — 1 typed, 0 skipped'
  );
});

test('a gap hands its lines over when it is opened', () => {
  const { page, review } = pageWith(changedFile());
  const gap = page.files()[0].querySelectorAll('.gap')[0];

  page.click(gap);
  assert.deepEqual(lastSent(page), {
    type: 'expandGap',
    file: '/w/a.ts',
    from: 1,
    to: 6,
  });

  pump(page, review);
  assert.equal(page.files()[0].querySelectorAll('.gap').length, 1);
  assert.deepEqual(
    page
      .files()[0]
      .querySelector('.context')
      ?.querySelectorAll('.row')
      .map(row)
      .map((line) => [line.n, line.text]),
    [
      ['1', 'line 1'],
      ['2', 'line 2'],
      ['3', 'line 3'],
      ['4', 'line 4'],
      ['5', 'line 5'],
      ['6', 'line 6'],
    ]
  );
});

test('clicking a region moves the caret there; a claimed one is left alone', () => {
  const { page } = pageWith(changedFile('/w/a.ts'), changedFile('/w/b.ts'));
  const second = page.regions(page.files()[1])[0];

  page.click(second);
  assert.equal(second.classList.contains('active'), true);

  page.receive({
    type: 'section',
    file: '/w/b.ts',
    index: 0,
    state: { position: 11, touched: false, outcome: 'skipped' },
  });
  page.click(second);
  assert.equal(second.classList.contains('active'), false);
});

test('the summary says what the whole change set comes to', () => {
  const { page } = pageWith(changedFile('/w/a.ts'), deletedLineFile('/w/b.ts'));

  assert.equal(
    page.byId('summary').textContent,
    '2 files · +1 −2 · 2 regions still owed · compared against ' + LABEL
  );
});

test('code goes into the page as text, never as markup', () => {
  const baseline = file(20);
  const current = baseline.replace('line 10', '<script>alert(1)</script>');
  const { page } = pageWith(loaded('/w/a.ts', baseline, current));

  const region = page.regions(page.files()[0])[0];
  // A file's own contents can never become part of the page's structure.
  assert.equal(region.querySelectorAll('script').length, 0);
  assert.equal(row(added(region)[0]).owed, '<script>alert(1)</script>');
});

test('backspace erases nothing, and says so', () => {
  const { page } = pageWith(changedFile());

  const pressed = page.press('Backspace');

  assert.equal(pressed.defaultPrevented, true);
  assert.deepEqual(page.sent, []);
  assert.match(page.byId('status').textContent, /nothing to erase/);
});

// --- the page against the real review state ---------------------------------

test('typing a region through to the end claims it and finishes its file', () => {
  const { page, review } = pageWith(changedFile());

  let finished: string[] = [];
  for (const key of 'changed 10') {
    page.press(key);
    finished = finished.concat(pump(page, review));
  }

  assert.deepEqual(finished, ['/w/a.ts']);
  const drawn = page.files()[0];
  assert.equal(drawn.classList.contains('done'), true);
  assert.equal(
    drawn.querySelector('.progress')?.textContent,
    'reviewed — 1 typed, 0 skipped'
  );
  assert.equal(page.byId('status').textContent, 'Every region on this page is claimed.');
  assert.match(page.byId('summary').textContent, /0 regions still owed/);
});

test('a key the region does not owe changes nothing on either side', () => {
  const { page, review } = pageWith(changedFile());

  page.press('z');
  pump(page, review);

  const region = page.regions(page.files()[0])[0];
  assert.equal(region.classList.contains('wrong'), true);
  assert.equal(row(added(region)[0]).covered, '');
  // The page never took the file over, so the file stays outside the review.
  assert.equal(review.owns('/w/a.ts'), false);
});

test('skipping walks the page file by file until nothing is owed', () => {
  const { page, review } = pageWith(
    changedFile('/w/a.ts'),
    deletedLineFile('/w/b.ts'),
    changedFile('/w/c.ts')
  );

  const finished: string[] = [];
  for (let i = 0; i < 3; i++) {
    // Alt+S on a region that owes text, and the acknowledgement on the deletion:
    // the page sends whichever its active region asks for.
    page.press({ key: 's', altKey: true });
    page.press('Enter');
    finished.push(...pump(page, review));
  }

  assert.deepEqual(finished, ['/w/a.ts', '/w/b.ts', '/w/c.ts']);
  assert.equal(page.files().every((drawn) => drawn.classList.contains('done')), true);
});

// --- handing a file to an editor review -------------------------------------

/** One region's lens controls, by their labels. */
function lensLabels(region: FakeElement): string[] {
  return (
    region.querySelector('.lens')?.querySelectorAll('button').map((b) => b.textContent) ??
    []
  );
}

/** The lens control with this label, for a click. */
function lensButton(region: FakeElement, label: string): FakeElement {
  const button = region
    .querySelector('.lens')
    ?.querySelectorAll('button')
    .find((b) => b.textContent === label);
  assert.ok(button, `no "${label}" control on this region`);
  return button;
}

test('the region being worked on offers to be written by hand', () => {
  const { page } = pageWith(changedFile());
  const region = page.regions(page.files()[0])[0];

  assert.deepEqual(lensLabels(region), [
    'Fill line (Alt+F)',
    'Skip (Alt+S)',
    'Write it yourself (Ctrl+E)',
    'Open here',
  ]);

  page.click(lensButton(region, 'Write it yourself (Ctrl+E)'));

  assert.deepEqual(lastSent(page), { type: 'editHere', file: '/w/a.ts', index: 0 });
});

test('a deletion can be written by hand too, though it has nothing to type', () => {
  const { page } = pageWith(deletedLineFile('/w/b.ts'));
  const region = page.regions(page.files()[0])[0];

  assert.deepEqual(lensLabels(region), [
    'Confirm (Enter)',
    'Write it yourself (Ctrl+E)',
    'Open here',
  ]);
});

test('the key asks the page which region it meant', () => {
  const { page } = pageWith(changedFile());

  page.receive({ type: 'askEdit' });

  assert.deepEqual(lastSent(page), { type: 'editHere', file: '/w/a.ts', index: 0 });
});

test('the key with nothing being worked on says so rather than guessing', () => {
  const { page } = pageWith(changedFile());
  page.receive({
    type: 'section',
    file: '/w/a.ts',
    index: 0,
    state: { position: 11, touched: true, outcome: 'typed' },
  });
  page.sent.length = 0;

  page.receive({ type: 'askEdit' });

  assert.deepEqual(page.sent, []);
  assert.equal(
    page.byId('status').textContent,
    'no region is being worked on — click one first.'
  );
});

test('a file that went to the editor says so, and stops taking keystrokes', () => {
  const { page } = pageWith(changedFile('/w/a.ts'), changedFile('/w/b.ts'));

  page.receive({ type: 'handed', file: '/w/a.ts' });

  const [first, second] = page.files();
  assert.equal(first.classList.contains('handed'), true);
  assert.equal(first.querySelector('.progress')?.textContent, 'being reviewed in the editor');
  // Its regions stay drawn — this is still the document of the change set — but
  // nothing here types them, so the only controls left are ways of looking.
  assert.deepEqual(lensLabels(page.regions(first)[0]), ['Open here']);

  // The caret still landed somewhere, on the next file's first region.
  assert.equal(page.regions(second)[0].classList.contains('active'), true);
  page.sent.length = 0;
  page.press('c');
  assert.deepEqual(lastSent(page), { type: 'type', file: '/w/b.ts', index: 0, text: 'c' });
});

test('a handed-over file cannot be clicked back into', () => {
  const { page } = pageWith(changedFile());
  page.receive({ type: 'handed', file: '/w/a.ts' });
  const region = page.regions(page.files()[0])[0];

  page.click(region);

  assert.equal(region.classList.contains('active'), false);
  assert.equal(
    page.byId('status').textContent,
    'Nothing left to type here — the rest went to the editor.'
  );
});

test('what a handed-over file covered stays drawn as covered', () => {
  const { page, review } = pageWith(changedFile());
  page.press('c');
  page.press('h');
  pump(page, review);

  page.receive({ type: 'handed', file: '/w/a.ts' });

  const line = page.regions(page.files()[0])[0];
  assert.equal(added(line).map(row)[0].covered, 'ch');
});
