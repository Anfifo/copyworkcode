import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { countLines } from '../../src/core/diff';
import { badgeLabel, removalHover, removalRanges } from '../../src/removalMark';
import { removedUri } from '../../src/retypeController';

/**
 * End-to-end checks inside a live extension host. A review is armed by default,
 * so half of what is worth checking is the line between what guidance allows and
 * what it doesn't: a wrong key, a raw edit command and a backspace all bounce off
 * an armed editor, and all three land once editing is enabled. The other half is
 * what happens when the buffer changes anyway — the reviewer's own writing,
 * something else writing to the file mid-review, the buffer being replaced
 * outright. Alongside those, the plain flow: typing, fills, skips, deletion
 * confirms, free roam across sections, and the git comparison mode.
 *
 * Runs sequentially — one review is live at a time by design.
 */
export async function run(): Promise<void> {
  const ws = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const file = (name: string) => path.join(ws, name);
  const baselineOf = (name: string) =>
    fs.readFileSync(
      path.join(ws, '.copyworkcode', 'baselines', encodeURIComponent(name)),
      'utf8'
    );
  const onDisk = (name: string) => fs.readFileSync(file(name), 'utf8');
  const stateFile = path.join(ws, '.copyworkcode', 'state.json');
  const reviews = () =>
    JSON.parse(fs.readFileSync(stateFile, 'utf8')).reviews as {
      file: string;
      outcome: string;
      hunksTyped?: number;
      hunksSkipped?: number;
      hunksConfirmed?: number;
      hunksEdited?: number;
    }[];
  const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

  const ext = vscode.extensions.all.find((e) => e.id.endsWith('.copyworkcode'));
  assert.ok(ext, 'extension is present in the host');
  await ext.activate();
  assert.ok(ext.isActive, 'extension activates');

  const exec = (command: string, ...args: unknown[]) =>
    vscode.commands.executeCommand(command, ...args);
  const type = (text: string) => exec('type', { text });
  /** Type the visible characters of a target: whitespace snaps on its own. */
  const typeAll = async (text: string) => {
    for (const key of text) await type(key);
  };
  const review = async (name: string) => {
    await exec('copyworkcode.reviewFile', file(name));
    await settle();
    const document = vscode.workspace.textDocuments.find(
      (d) => d.uri.fsPath === file(name)
    );
    assert.ok(document, `review of ${name} opened the file`);
    return document;
  };
  const editorOf = (name: string) => {
    const editor = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.fsPath === file(name)
    );
    assert.ok(editor, `${name} is showing in an editor`);
    return editor;
  };
  /** Put the cursor where a reviewer clicking there would put it. */
  const clickAt = async (name: string, offset: number) => {
    const editor = editorOf(name);
    const at = editor.document.positionAt(offset);
    editor.selection = new vscode.Selection(at, at);
    await settle(150);
  };
  /** What a hover over the start of a line says, as one string. */
  const hoverAt = async (document: vscode.TextDocument, line: number) =>
    (
      (await exec(
        'vscode.executeHoverProvider',
        document.uri,
        new vscode.Position(line, 0)
      )) as vscode.Hover[]
    )
      .flatMap((hover) => hover.contents)
      .map((part) => (part as vscode.MarkdownString).value ?? '')
      .join('\n');
  /** Claim whatever is left of a review, however many sections that is. */
  const claimRest = async () => {
    for (let i = 0; i < 5; i++) {
      await exec('copyworkcode.skipSection');
      await settle(120);
    }
    await exec('copyworkcode.finishReview');
    await settle();
  };

  // --- The plain flow: type the section, the buffer never changes ------------
  const sample = await review('sample.ts');
  assert.equal(
    sample.getText(),
    'line1\nline2\nline3\n',
    'the buffer keeps its full content at review start'
  );
  assert.equal(sample.isDirty, false, 'starting a review never dirties the file');

  await typeAll('line2');
  assert.equal(
    sample.getText(),
    'line1\nline2\nline3\n',
    'typing the target leaves the content byte-identical'
  );
  assert.equal(sample.isDirty, false, 'a matched review never dirties the file');
  assert.equal(baselineOf('sample.ts'), 'line1\nline2\nline3\n');
  assert.equal(reviews().length, 1);
  assert.equal(reviews()[0].outcome, 'typed');
  assert.equal(reviews()[0].hunksTyped, 1);

  // --- Skip a section --------------------------------------------------------
  await review('skipsection.ts');
  await exec('copyworkcode.skipSection');
  await settle();
  assert.equal(onDisk('skipsection.ts'), 'a\nb\n', 'skipping changes nothing');
  assert.equal(baselineOf('skipsection.ts'), 'a\nb\n');
  assert.equal(reviews()[1].outcome, 'skipped');

  // --- Skip a whole file from the tree --------------------------------------
  await exec('copyworkcode.skipFile', {
    resourceUri: vscode.Uri.file(file('skipfile.ts')),
  });
  await settle();
  assert.equal(baselineOf('skipfile.ts'), 'x\ny\n');
  assert.equal(reviews()[2].outcome, 'skipped');

  // --- Stopping records nothing and leaves the debt --------------------------
  const aborted = await review('aborted.ts');
  await type('t');
  assert.equal(
    aborted.getText(),
    'one\ntwo\n',
    'matched keystrokes change nothing in the buffer'
  );
  await exec('copyworkcode.abortReview');
  await settle();
  assert.equal(aborted.isDirty, false, 'stopping a matched review leaves it clean');
  assert.equal(baselineOf('aborted.ts'), 'one\n', 'stopping leaves debt in place');
  assert.equal(reviews().length, 3, 'stopping records no review');

  // --- A doubled gesture starts exactly one review --------------------------
  await Promise.all([
    exec('copyworkcode.reviewFile', file('race.ts')),
    exec('copyworkcode.reviewFile', file('race.ts')),
  ]);
  await settle();
  await typeAll('r2');
  assert.equal(baselineOf('race.ts'), 'r1\nr2\n');
  assert.equal(reviews().length, 4, 'a double invocation records a single review');

  // --- Tab fills the next word, mixed with typing ---------------------------
  const tabbed = await review('tabbed.ts');
  await exec('copyworkcode.fillNextWord'); // the indent and "x"
  await settle(150);
  await typeAll(' =');
  await exec('copyworkcode.fillNextWord'); // " y"
  await settle(150);
  await type(';');
  await settle();
  assert.equal(
    tabbed.getText(),
    'f\n\tx = y;\n',
    'a tab fill snaps the indentation and never edits the buffer'
  );
  assert.equal(baselineOf('tabbed.ts'), 'f\n\tx = y;\n');
  assert.equal(reviews()[4].outcome, 'typed', 'a part-typed section counts as typed');

  // --- A raw edit bounces off an armed review, and lands once asked for -----
  // Armed, the editor carries the session read-only flag, so a gesture that
  // isn't a matched keystroke does nothing at all. Enabling editing makes the
  // same gesture a real edit: the section grows around it, and typing carries on
  // from there when guidance comes back.
  const entered = await review('entered.ts');
  await exec('default:type', { text: '!' });
  await settle();
  assert.equal(
    entered.getText(),
    'start\na\nb\n',
    'an edit off the matching path is inert while guidance is armed'
  );
  await exec('copyworkcode.enableEditing');
  await settle(150);
  await exec('default:type', { text: '!' });
  await settle();
  assert.equal(
    entered.getText(),
    'start\n!a\nb\n',
    'with editing enabled the same gesture reaches the buffer'
  );
  await exec('copyworkcode.resumeTyping');
  await settle(150);
  await type('a');
  await exec('copyworkcode.typeEnter');
  await type('b');
  await settle();
  assert.equal(
    baselineOf('entered.ts'),
    'start\n!a\nb\n',
    'the baseline records the reviewed content, including the edit'
  );
  assert.equal(reviews().length, 6, 'the review survived the raw edit');
  assert.equal(
    reviews()[5].hunksEdited,
    1,
    'a section the reviewer wrote in is recorded as edited, not typed'
  );

  // --- A reload from disk does not end the review ---------------------------
  const reload = await review('reload.ts');
  fs.writeFileSync(file('reload.ts'), 'external\n');
  await exec('workbench.action.files.revert');
  await settle(600);
  assert.equal(reload.getText(), 'external\n', 'the reloaded content is kept');
  assert.equal(reload.isDirty, false, 'no stale content is resurrected');
  await exec('copyworkcode.jumpToReview');
  await settle(150);
  await claimRest();
  assert.equal(
    baselineOf('reload.ts'),
    'external\n',
    'the review outlived the reload and could still be completed'
  );
  assert.equal(reviews().length, 7, 'the reloaded review is recorded once');

  // --- Replacing the whole buffer re-derives the sections -------------------
  // A single change covering the document says nothing about where the old text
  // went, so remapping it would collapse every section onto one range. The
  // review restarts from the new content instead — and stays typeable.
  //
  // Driven with editing enabled, because an armed review refuses a programmatic
  // edit as flatly as it refuses a paste: the read-only flag is not a UI hint,
  // and this is the reviewer selecting everything and writing over it. A file
  // replaced on *disk* does reach an armed review — that path is `reload.ts`.
  const replaced = await review('replaced.ts');
  await exec('copyworkcode.enableEditing');
  await settle(150);
  const whole = new vscode.Range(
    replaced.positionAt(0),
    replaced.positionAt(replaced.getText().length)
  );
  await editorOf('replaced.ts').edit((edit) => edit.replace(whole, 'brand\nnew\n'));
  await settle();
  assert.equal(replaced.getText(), 'brand\nnew\n');
  await exec('copyworkcode.resumeTyping');
  await settle(150);
  await typeAll('brandnew');
  await settle();
  assert.equal(
    baselineOf('replaced.ts'),
    'brand\nnew\n',
    'the restarted review typed out the replacement content'
  );
  assert.equal(reviews()[7].hunksTyped, 1, 'the re-derived section counts as typed');

  // --- Closing the review editor tears the session down --------------------
  // Regression for the wedge where an abandoned review blocked every future
  // one: close a review mid-flight, then run a full review of a *different*
  // file. If the first session leaked, the second never starts and these
  // assertions land on the wrong file.
  await review('closed.ts');
  await exec('workbench.action.closeActiveEditor');
  await settle(600);

  // --- A file created from scratch (empty baseline) reviews sanely ----------
  const fresh = await review('fresh.ts');
  assert.equal(
    fresh.getText(),
    'created\nby agent\n',
    'a whole-file section stays fully visible at review start'
  );
  await exec('copyworkcode.skipSection');
  await settle();
  assert.equal(baselineOf('fresh.ts'), 'created\nby agent\n');
  assert.equal(baselineOf('closed.ts'), 'c1\n', 'the abandoned review advanced nothing');
  assert.equal(reviews().length, 9, 'closing the editor records no review');
  assert.ok(
    reviews()[8].file.endsWith('fresh.ts'),
    'the review after an abandoned one targets the right file'
  );

  // --- A deletion-only change is confirmed, not typed ----------------------
  const removed = await review('removed.ts');
  await exec('copyworkcode.confirmSection');
  await settle();
  assert.equal(removed.getText(), 'keep\n', 'confirming a deletion edits nothing');
  assert.equal(baselineOf('removed.ts'), 'keep\n');
  assert.equal(reviews()[9].outcome, 'typed');
  assert.equal(reviews()[9].hunksConfirmed, 1);

  // --- A whole section filled word by word ---------------------------------
  const word = await review('word.ts');
  // 'const', ' sum', ' =', ' add', '(', 'a', ',', ' b', ');\n'
  for (let i = 0; i < 9; i++) {
    await exec('copyworkcode.fillNextWord');
    await settle(120);
  }
  assert.equal(
    word.getText(),
    'w1\nconst sum = add(a, b);\n',
    'filling words leaves the content byte-identical'
  );
  assert.equal(baselineOf('word.ts'), 'w1\nconst sum = add(a, b);\n');
  assert.equal(reviews().length, 11, 'the word-filled review is recorded');

  // --- A wrong key changes nothing, however many times it is pressed -------
  const wrongKey = await review('wrongkey.ts');
  assert.equal(wrongKey.getText(), 'd1\nORIGINAL\n');

  await type('x');
  await settle(150);
  assert.equal(
    wrongKey.getText(),
    'd1\nORIGINAL\n',
    'a keystroke that does not match the target inserts nothing'
  );

  for (let i = 0; i < 9; i++) {
    await type('x');
    await settle(80);
  }
  assert.equal(
    wrongKey.getText(),
    'd1\nORIGINAL\n',
    'ten wrong keys are ten wrong keys — the file cannot drift into them'
  );
  await exec('copyworkcode.finishReview');
  await settle();
  assert.equal(
    reviews().length,
    11,
    'finishing is refused while a section is still owed'
  );

  // The same keystroke, once the reviewer has asked for the editor. The section
  // keeps its place, so guidance picks the rest up where it left off.
  await exec('copyworkcode.enableEditing');
  await settle(150);
  await type('x');
  await settle(150);
  assert.equal(
    wrongKey.getText(),
    'd1\nxORIGINAL\n',
    'with editing enabled the keystroke goes into the file'
  );
  await exec('copyworkcode.resumeTyping');
  await settle(150);
  await typeAll('ORIGINAL');
  await settle();
  assert.equal(
    wrongKey.getText(),
    'd1\nxORIGINAL\n',
    'the rest of the section was typed out, not inserted a second time'
  );
  assert.equal(reviews().length, 12, 'typing the rest of it finishes the review');
  assert.equal(reviews()[11].hunksEdited, 1, 'recorded as a section written in');
  assert.equal(
    baselineOf('wrongkey.ts'),
    onDisk('wrongkey.ts'),
    'the baseline records the reviewer’s version of the file'
  );

  // --- Backspace: inert while armed, an ordinary erase once enabled ---------
  const backspace = await review('backspace.ts');
  await typeAll('be');
  await exec('deleteLeft');
  await settle();
  assert.equal(
    backspace.getText(),
    'b1\nbeta\n',
    'backspace cannot take the target apart while guidance is armed'
  );
  await exec('copyworkcode.enableEditing');
  await settle(150);
  await exec('deleteLeft');
  await settle();
  assert.equal(
    backspace.getText(),
    'b1\nbta\n',
    'with editing enabled it erases a real character — no keybinding of ours'
  );
  await exec('copyworkcode.resumeTyping');
  await settle(400);
  // Going back to typing writes what was written by hand. An armed review can
  // neither dirty the buffer nor save it, so the erase would otherwise sit in a
  // buffer the reviewer cannot write until the review ends.
  assert.equal(
    backspace.isDirty,
    false,
    'resuming typing saved what was written by hand'
  );
  assert.equal(onDisk('backspace.ts'), 'b1\nbta\n', 'and it reached the file');
  await typeAll('ta');
  await settle();
  assert.equal(
    baselineOf('backspace.ts'),
    'b1\nbta\n',
    'the section stayed coherent across the erase and completed'
  );
  assert.equal(reviews()[12].outcome, 'typed');
  assert.equal(
    reviews()[12].hunksEdited,
    1,
    'erasing part of the target counts as writing it yourself'
  );

  // --- Something else writing to the file mid-review -----------------------
  // The old flow killed the review on any change it had not made itself. Now
  // the sections are re-anchored and the walk carries on, however many changes
  // arrive and wherever they land. Editing is enabled for the same reason as
  // the block above: an armed editor refuses writes from anywhere, including
  // another extension's.
  const foreign = await review('foreign.ts');
  await exec('copyworkcode.enableEditing');
  await settle(150);
  const foreignEdit = new vscode.WorkspaceEdit();
  foreignEdit.insert(foreign.uri, new vscode.Position(0, 0), 'inserted\n');
  foreignEdit.insert(
    foreign.uri,
    foreign.lineAt(foreign.lineCount - 1).range.end,
    'tail\n'
  );
  assert.ok(await vscode.workspace.applyEdit(foreignEdit), 'the foreign edit applied');
  await settle();
  // A burst, to check that a file being written repeatedly does not tear the
  // review down or turn every change into its own interruption.
  for (let i = 0; i < 4; i++) {
    const burst = new vscode.WorkspaceEdit();
    burst.insert(foreign.uri, new vscode.Position(0, 0), `burst${i}\n`);
    await vscode.workspace.applyEdit(burst);
  }
  await settle();
  await exec('copyworkcode.resumeTyping');
  await settle(150);
  await exec('copyworkcode.jumpToReview');
  await settle(150);
  await typeAll('alpha');
  await settle(150);
  await typeAll('beta');
  await settle();
  assert.ok(
    foreign.getText().includes('alpha\n') && foreign.getText().includes('beta\n'),
    'the reviewed text came through the remapping unchanged'
  );
  assert.equal(
    baselineOf('foreign.ts'),
    foreign.getText(),
    'both sections were typed after five foreign writes moved them'
  );
  assert.equal(reviews().length, 14, 'the review survived and was recorded once');
  assert.equal(reviews()[13].hunksTyped, 2, 'both sections count as typed');

  // --- Clicking into the middle of a section and typing ---------------------
  // The gesture every reviewer makes first. Guidance used to need the caret on
  // the exact next character, so a click anywhere else in the changed code sent
  // the keystrokes to the plain editor and they went in *beside* the text they
  // were meant to reproduce. Typing anywhere in what a section still owes has
  // to be matched, and the caret has to end up where the typing is going.
  const inbox = await review('inbox.ts');
  await clickAt('inbox.ts', inbox.getText().indexOf('de the'));
  const caret = editorOf('inbox.ts').selection.active;
  assert.equal(
    inbox.offsetAt(caret),
    inbox.getText().indexOf('inside'),
    'the caret moved to the typing position the click landed past'
  );
  await typeAll('ins');
  await settle();
  assert.equal(
    inbox.getText(),
    'i1\ninside the box\n',
    'typing after the click was matched, not inserted beside the target'
  );
  await exec('copyworkcode.skipSection');
  await settle();
  assert.equal(baselineOf('inbox.ts'), 'i1\ninside the box\n');
  assert.equal(reviews().length, 15, 'the clicked-into review is recorded');

  // --- Free roam: sections are a set, so the second one can go first -------
  const roam = await review('roam.ts');
  await clickAt('roam.ts', roam.getText().indexOf('two'));
  await typeAll('two');
  await settle(150);
  // Claiming the last section walks the cursor back to the one still owed.
  await typeAll('one');
  await settle();
  assert.equal(roam.getText(), 'r1\none\nr3\ntwo\nr5\n', 'roaming never edits the buffer');
  assert.equal(baselineOf('roam.ts'), 'r1\none\nr3\ntwo\nr5\n');
  assert.equal(reviews()[15].hunksTyped, 2, 'both sections claimed, in either order');

  // --- The read-only flag lifts when the review ends -----------------------
  const config = () => vscode.workspace.getConfiguration('copyworkcode');
  const locked = await review('locked.ts');
  await typeAll('locked');
  await settle();
  assert.equal(baselineOf('locked.ts'), 'l1\nlocked\n');
  assert.equal(reviews()[16].outcome, 'typed');
  // The flag has to lift when the review ends, or the file stays unwritable for
  // the rest of the session.
  await vscode.window.showTextDocument(locked);
  await settle();
  await type('q');
  assert.ok(locked.getText().includes('q'), 'the file is writable again afterwards');

  // --- Comparing against git reaches files with no snapshot ----------------
  await exec('copyworkcode.reviewFile', file('gitonly.ts'));
  await settle();
  assert.equal(
    vscode.workspace.textDocuments.some((d) => d.uri.fsPath === file('gitonly.ts')),
    false,
    'with no snapshot behind it, the tracked queue has nothing to review'
  );
  await exec('copyworkcode.useGitBaseline');
  await settle();
  await review('gitonly.ts');
  await typeAll('g2');
  await settle();
  assert.equal(
    baselineOf('gitonly.ts'),
    'g1\ng2\n',
    'reviewing in git mode writes the snapshot, so the file leaves both queues'
  );
  assert.equal(reviews().length, 18, 'the git-mode review is recorded');
  await exec('copyworkcode.useTrackedBaseline');
  await settle();

  // --- Changing the animation level mid-review does not disturb it ---------
  // The animation owns decoration types that are disposed and rebuilt when the
  // level changes; doing that under a live review must not touch the buffer, a
  // section's position, or the outcome. The mismatch on the way through also
  // drives the reject animation across one of those rebuilds.
  const animated = await review('animated.ts');
  await type('a');
  await type('q'); // the wrong key, and the one that flashes
  await settle(150);
  assert.equal(animated.getText(), 'an1\nan2\n');
  await config().update('animations', 'subtle', true);
  await settle();
  await type('n');
  await config().update('animations', 'off', true);
  await settle();
  await type('2');
  await settle();
  assert.equal(
    animated.getText(),
    'an1\nan2\n',
    'animation frames never edit the buffer'
  );
  assert.equal(
    baselineOf('animated.ts'),
    'an1\nan2\n',
    'the review completed across two animation level changes'
  );
  assert.equal(reviews().length, 19, 'the review survived the level changes');
  assert.equal(reviews()[18].hunksTyped, 1);
  await config().update('animations', undefined, true);
  await settle();

  // --- Keystrokes arriving faster than they can be answered ----------------
  // Fired without awaiting each one, which pins down what a burst has to
  // produce: it edits nothing, and it is answered in the order it arrived —
  // typing the rest of the section afterwards only completes it if all five
  // keystrokes advanced the position, one after another. Commands driven from
  // the extension turn out to arrive sequentially, so this does not prove the
  // gesture queue is load-bearing — it fixes the behaviour a burst must have,
  // however the keystrokes get here.
  const fast = await review('fast.ts');
  await Promise.all([...'quick'].map((key) => type(key)));
  await settle();
  assert.equal(
    fast.getText(),
    'q1\nquick brown\n',
    'a burst of matched keystrokes edits nothing'
  );
  await Promise.all([...'ABC'].map((key) => type(key)));
  await settle();
  assert.equal(
    fast.getText(),
    'q1\nquick brown\n',
    'a burst of wrong keys leaves the buffer alone too'
  );
  await typeAll('brown');
  await settle();
  assert.equal(
    baselineOf('fast.ts'),
    'q1\nquick brown\n',
    'the burst was answered in order, so the rest of it could be typed out'
  );
  assert.equal(reviews().length, 20, 'the fast-typed review is recorded');
  assert.equal(reviews()[19].hunksTyped, 1, 'and counts as typed, not written in');

  // --- A review that opens with editing already enabled --------------------
  // The setting changes which state a review starts in and nothing else: the
  // first keystroke is an edit rather than a match, and the section still has to
  // be claimed before the review can finish.
  await config().update('startEditing', true, true);
  await settle();
  const editFirst = await review('startedit.ts');
  await exec('default:type', { text: '!' });
  await settle(150);
  assert.equal(
    editFirst.getText(),
    'e1\n!edited\n',
    'with the setting on, the first keystroke edits the file'
  );
  await config().update('startEditing', undefined, true);
  await settle();
  await exec('copyworkcode.resumeTyping');
  await settle(300);
  await typeAll('edited');
  await settle();
  assert.equal(
    editFirst.getText(),
    'e1\n!edited\n',
    'and guidance took the rest of the section from there'
  );
  assert.equal(reviews().length, 21, 'the review that opened editable is recorded');
  assert.equal(reviews()[20].hunksEdited, 1, 'recorded as a section written in');

  // --- Where a removal's boundary lands ------------------------------------
  // Decorations cannot be read back out of an editor, so nothing here can prove
  // the mark looks right. What it does pin down is the part that could be
  // *wrong* rather than merely ugly: which line each removal is anchored to and
  // which side of it the rule goes, against real documents rather than a model
  // of one. Line counting is the trap — the diff does not count a trailing
  // newline as a line and an editor does.
  const openText = async (content: string) =>
    vscode.workspace.openTextDocument({ content, language: 'plaintext' });
  const tail = ['four', 'five', 'six', 'seven'];
  const gone = Array.from({ length: 9 }, (_, i) => `was line ${i}`);

  const terminated = await openText('one\ntwo\nthree\n');
  const deletion = { line: 1, text: ['first gone', 'second gone'], atEnd: false, replaced: false };
  const mid = removalRanges(terminated, [deletion]);
  assert.equal(mid.below.length, 0, 'a mid-file removal is not marked from below');
  assert.equal(mid.above.length, 1);
  assert.equal(mid.above[0].start.line, 1, 'the rule marks the line that took its place');
  assert.ok(mid.above[0].isEmpty, 'the boundary is a rule between lines, not a range');
  assert.equal(mid.badges.length, 1);
  assert.equal(
    mid.badges[0].label,
    '−2',
    'the badge says how much went, not just that something did'
  );
  assert.equal(
    mid.badges[0].range.start.line,
    1,
    'beside the line the rule is drawn at'
  );

  // A replacement's additions are already dimmed, boxed and lensed, and its
  // lens says in words that lines went to make room. It keeps the badge, which
  // is the way in to what it replaced, and gives up the rule.
  const replacement = removalRanges(terminated, [{ ...deletion, replaced: true }]);
  assert.deepEqual(
    [replacement.above.length, replacement.below.length],
    [0, 0],
    'a replacement draws no rule over the lines that took the removal place'
  );
  assert.equal(replacement.badges.length, 1, 'but is still marked in the gutter');
  assert.equal(
    badgeLabel(150),
    '−99+',
    'a count too big to read at gutter size stops trying to be exact'
  );

  // The trailing newline leaves an empty line where the removed text was, so
  // the rule still goes above a line — that line just has nothing on it.
  const atEndTerminated = removalRanges(terminated, [
    { line: countLines('one\ntwo\nthree\n'), text: ['gone'], atEnd: true, replaced: false },
  ]);
  assert.equal(atEndTerminated.below.length, 0);
  assert.equal(atEndTerminated.above.length, 1);
  assert.equal(
    atEndTerminated.above[0].start.line,
    3,
    'a removal past the end of a newline-terminated file marks its empty last line'
  );
  assert.equal(atEndTerminated.badges[0].label, '−1');

  // Ending mid-line leaves nothing above to draw, so the rule moves below.
  const unterminated = await openText('one\ntwo\nthree');
  const atEndMidLine = removalRanges(unterminated, [
    { line: countLines('one\ntwo\nthree'), text: tail, atEnd: true, replaced: false },
  ]);
  assert.equal(atEndMidLine.above.length, 0);
  assert.equal(atEndMidLine.below.length, 1);
  assert.equal(
    atEndMidLine.below[0].start.line,
    2,
    'with no line past the end, the rule goes under the last one that survived'
  );

  // A file emptied outright still has one line to hang the rule on.
  const emptied = await openText('');
  const allGone = removalRanges(emptied, [{ line: 0, text: gone, atEnd: true, replaced: false }]);
  assert.equal(allGone.above.length + allGone.below.length, 1, 'an emptied file is still marked');
  assert.deepEqual(
    removalRanges(terminated, [{ line: 0, text: [], atEnd: false, replaced: false }]),
    { above: [], below: [], badges: [] },
    'a hunk that removed nothing is not a removal'
  );

  // --- What the mark cannot say: the lines themselves -----------------------
  // The hover is the answer to the question the mark provokes, so it has to
  // carry the removed text verbatim, in the document's own language, and a way
  // through to the rest when there is more of it than a popup should hold.
  const showAll = vscode.Uri.parse('command:copyworkcode.peekRemoved?%5B0%5D');
  const hoverOf = (text: string[]) =>
    removalHover(terminated, { line: 1, text, atEnd: false, replaced: false }, showAll);
  const shortHover = hoverOf(['first gone', 'second gone']);
  assert.equal(shortHover?.range?.start.line, 1, 'the hover covers the marked line');
  const short = (shortHover!.contents[0] as vscode.MarkdownString).value;
  assert.ok(
    short.includes(['```plaintext', 'first gone', 'second gone', '```'].join('\n')),
    'the removed lines arrive as code in the language of the file that lost them'
  );
  assert.ok(short.includes('2 lines deleted'), 'headed by the count the badge shows');
  assert.ok(
    short.includes('command:copyworkcode.peekRemoved'),
    'and carries the link to the whole removal'
  );

  const long = (hoverOf(gone.concat(Array.from({ length: 11 }, (_, i) => `more ${i}`)))!
    .contents[0] as vscode.MarkdownString).value;
  assert.ok(long.includes('was line 8'), 'a long removal shows what fits');
  assert.ok(!long.includes('more 4'), 'and stops rather than swallowing the file');
  assert.ok(long.includes('8 more not shown'), 'saying how much is left behind the link');
  assert.equal(hoverOf([]), undefined, 'nothing removed, nothing to hover');

  // End to end: the provider is registered, and answers on the line a live
  // review marked — the half of this that no direct call can prove.
  const deleted = await review('deleted.ts');
  const marks = await hoverAt(deleted, 1);
  assert.ok(
    marks.includes('first gone') && marks.includes('second gone'),
    'hovering the line a removal was marked at shows what was removed there'
  );

  // And what the hover's link opens: the removed lines as a document of their
  // own, named after the review and the section that lost them. 'keep' is five
  // characters, so that section starts at offset five; which review of the run
  // this is does not matter, only that exactly one of them owns the text.
  const named = await Promise.all(
    Array.from({ length: 40 }, (_, id) =>
      vscode.workspace
        .openTextDocument(removedUri(deleted.uri.fsPath, id, 5, 2))
        .then((document) => document.getText())
    )
  );
  const removedText = ['first gone', 'second gone', ''].join('\n');
  assert.equal(
    named.filter((text) => text === removedText).length,
    1,
    'one review owns the removed lines, and the panel document holds them whole'
  );
  assert.ok(
    named.every((text) => text === removedText || text === ''),
    'every other name resolves to nothing — these documents are cached by URI'
  );

  // And the command the link carries. The panel it opens is UI no suite can
  // read, but a wrong command name or argument shape fails here rather than
  // silently doing nothing under the reviewer's click.
  await exec('copyworkcode.peekRemoved', 5);
  await settle();

  // --- The mark is debt, not history ----------------------------------------
  // Claiming a section takes its mark with it. Decorations cannot be read back,
  // but the hover is painted from the same list, so it answers for exactly the
  // removals that are still marked: it going quiet is the mark going with it.
  // The review is still live throughout — the file has a second section, and
  // the cursor moving onto it is what says so.
  const cleared = await review('cleared.ts');
  assert.ok(
    (await hoverAt(cleared, 1)).includes('gone'),
    'the removal is marked while its section is owed'
  );
  await exec('copyworkcode.confirmSection');
  await settle();
  assert.equal(
    cleared.offsetAt(editorOf('cleared.ts').selection.active),
    6,
    'confirming moves on to the section still owed, so the review is still live'
  );
  assert.ok(
    // Not emptiness: the language service answers for this line too, and what
    // it has to say about the code that survived is none of the review's
    // business either way.
    !(await hoverAt(cleared, 1)).includes('gone'),
    'and the claimed section no longer marks what it removed'
  );
  await exec('copyworkcode.abortReview');
  await settle();

  // --- Clicking back into text already typed --------------------------------
  // A click anywhere in a section is someone pointing at the section, not at an
  // offset. The caret goes to where the typing goes, and the next key lands.
  const retouch = await review('retouch.ts');
  await typeAll('abc');
  const caretIn = () => retouch.offsetAt(editorOf('retouch.ts').selection.active);
  assert.equal(caretIn(), 6, 'three characters typed, caret three characters in');
  await clickAt('retouch.ts', 4);
  assert.equal(caretIn(), 6, 'a click behind the typing position is sent back to it');
  await type('d');
  assert.equal(caretIn(), 7, 'and the next key is matched as if nothing had moved');
  assert.equal(retouch.getText(), 't1\nabcdef\n');
  await exec('copyworkcode.abortReview');
  await settle();

  // --- Reset: every section owed again --------------------------------------
  // With nothing written by hand there is nothing to discard and nothing to
  // confirm, which is also the only half of the gesture a suite can drive: the
  // dialog guarding the other half is not something a test can answer.
  const resetme = await review('resetme.ts');
  await typeAll('sec');
  assert.equal(resetme.offsetAt(editorOf('resetme.ts').selection.active), 6);
  await exec('copyworkcode.resetReview');
  await settle();
  assert.equal(
    resetme.offsetAt(editorOf('resetme.ts').selection.active),
    3,
    'the reset puts the caret back at the top of the section'
  );
  await type('s');
  assert.equal(
    resetme.offsetAt(editorOf('resetme.ts').selection.active),
    4,
    'and the section owes its first character again'
  );
  assert.equal(
    resetme.getText(),
    's1\nsecond\nthird\n',
    'a reset with nothing written leaves the file exactly as it was'
  );
  await exec('copyworkcode.abortReview');
  await settle();

  // --- Moving to another file parks a review instead of ending it -----------
  // The reviewer who opens a second file has not abandoned the first one, so its
  // sections and their positions wait for them. What the parked file must *not*
  // keep is the review's hold on it: nothing is guiding it, so it has to be an
  // ordinary writable editor — and an edit landing in it while it waits moves
  // the parked review's own progress, exactly as it would a live one's.
  const held = await review('parked.ts');
  await typeAll('pa');
  const caretHeld = () => held.offsetAt(editorOf('parked.ts').selection.active);
  assert.equal(caretHeld(), 6, 'two characters typed, caret two characters in');

  const other = await review('other.ts');
  await type('o');
  assert.equal(
    other.offsetAt(editorOf('other.ts').selection.active),
    5,
    'the file opened second is the live review'
  );

  await vscode.window.showTextDocument(held, { preview: false });
  await settle(150);
  await clickAt('parked.ts', 6);
  await exec('default:type', { text: '!' });
  await settle();
  assert.equal(
    held.getText(),
    'pa1\npa!2\npa3\n',
    'the parked file is writable again — its review holds nothing'
  );

  await review('parked.ts');
  assert.equal(
    caretHeld(),
    7,
    'coming back lands where the parked review left off, past what was written in'
  );
  await type('2');
  assert.equal(caretHeld(), 8, 'and the next key is matched against what is still owed');
  await exec('copyworkcode.typeEnter');
  await settle(150);
  await typeAll('pa3');
  await exec('copyworkcode.typeEnter');
  await settle();
  assert.equal(
    baselineOf('parked.ts'),
    'pa1\npa!2\npa3\n',
    'the resumed review finished against the content it was actually reading'
  );
  assert.equal(reviews().length, 22, 'a resumed review records one review, not two');
  // Typed, not written in: a character that arrived while the review was parked
  // is not the reviewer taking the section over. Nothing was guiding the file
  // then, so that edit is indistinguishable from a formatter's or an agent's —
  // and the section it landed in still had to be typed out afterwards.
  assert.equal(reviews()[21].outcome, 'typed');
  assert.equal(reviews()[21].hunksTyped, 1);
  assert.equal(reviews()[21].hunksEdited, 0);

  // Finishing one file does not disturb the other one waiting: parking is per
  // file, and the review left behind is still exactly where it was.
  await review('other.ts');
  assert.equal(
    other.offsetAt(editorOf('other.ts').selection.active),
    5,
    'the second parked review survived the first one finishing'
  );

  await exec('copyworkcode.abortReview');
  await settle();

  await exec('copyworkcode.abortReview');
  await settle();

  // Typing must be back to normal once no review is active. Typed into a file
  // that was never a review editor, so this cannot pass or fail on whatever
  // the last section happened to leave focused.
  const plain = await vscode.workspace.openTextDocument(file('skipfile.ts'));
  await vscode.window.showTextDocument(plain, { preview: false });
  await settle();
  await type('z');
  assert.ok(plain.getText().includes('z'), 'default typing works after review ends');

  console.log('copyworkcode integration suite: all checks passed');
}
