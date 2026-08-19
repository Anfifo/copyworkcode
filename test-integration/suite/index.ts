import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * End-to-end checks inside a live extension host. The review runs in a normal
 * editable editor, so most of what is worth checking is what happens when the
 * buffer changes underneath it: diverging from the target one character at a
 * time, diverging far enough that the section is handed over, erasing with
 * backspace, something else writing to the file mid-review, and the buffer being
 * replaced outright. Alongside those, the plain flow — typing, fills, skips,
 * deletion confirms, free roam across sections, the read-only lock option, and
 * the git comparison mode.
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

  // --- A raw edit lands in the file and the review absorbs it ---------------
  // The old read-only review made any such gesture inert. Now it is a real
  // edit: the section grows around it and the walk carries on from there.
  const entered = await review('entered.ts');
  await exec('default:type', { text: '!' });
  await settle();
  assert.equal(
    entered.getText(),
    'start\n!a\nb\n',
    'an edit off the matching path reaches the buffer'
  );
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
  const replaced = await review('replaced.ts');
  const whole = new vscode.Range(
    replaced.positionAt(0),
    replaced.positionAt(replaced.getText().length)
  );
  await editorOf('replaced.ts').edit((edit) => edit.replace(whole, 'brand\nnew\n'));
  await settle();
  assert.equal(replaced.getText(), 'brand\nnew\n');
  await exec('copyworkcode.jumpToReview');
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

  // --- Diverging: a wrong character is a real edit, and ten in a row hand
  // --- the section over -----------------------------------------------------
  const diverge = await review('diverge.ts');
  assert.equal(diverge.getText(), 'd1\nORIGINAL\n');

  await type('x');
  await settle(150);
  assert.equal(
    diverge.getText(),
    'd1\nxORIGINAL\n',
    'a keystroke that does not match the target is still typed into the file'
  );

  for (let i = 0; i < 4; i++) {
    await type('x');
    await settle(80);
  }
  assert.equal(
    diverge.getText(),
    'd1\nxxxxxORIGINAL\n',
    'five of the reviewer’s own characters, all still matched against'
  );
  await exec('copyworkcode.finishReview');
  await settle();
  assert.equal(
    reviews().length,
    11,
    'finishing is refused while a section is still owed'
  );

  for (let i = 0; i < 5; i++) {
    await type('x');
    await settle(80);
  }
  assert.equal(
    diverge.getText(),
    'd1\nxxxxxxxxxxORIGINAL\n',
    'the tenth divergent character is typed like the rest'
  );
  assert.equal(
    reviews().length,
    11,
    'a section handed over does not finish the review by itself'
  );

  // Guidance is off for this section now: nothing is being matched, so this
  // keystroke is a plain insertion with no mismatch feedback behind it.
  await type('y');
  await settle(150);
  const divergeText = diverge.getText();
  assert.ok(
    divergeText.includes('y'),
    'typing in a handed-over section goes straight into the buffer'
  );
  assert.ok(divergeText.includes('xxxxxxxxxx'), 'the reviewer’s own run is intact');
  assert.ok(divergeText.includes('ORIGINAL'), 'the target text is still there');

  await exec('copyworkcode.finishReview');
  await settle();
  assert.equal(reviews().length, 12, 'the handed-over review finishes on request');
  assert.equal(reviews()[11].hunksEdited, 1, 'recorded as a section written by hand');
  assert.equal(
    baselineOf('diverge.ts'),
    onDisk('diverge.ts'),
    'the baseline records the reviewer’s version of the file'
  );

  // --- Backspace works, and gives back exactly what it erased ---------------
  const backspace = await review('backspace.ts');
  await typeAll('be');
  await exec('deleteLeft');
  await settle();
  assert.equal(
    backspace.getText(),
    'b1\nbta\n',
    'backspace erases a real character — with no keybinding of ours involved'
  );
  await typeAll('ta');
  await settle();
  assert.equal(
    baselineOf('backspace.ts'),
    'b1\nbta\n',
    'the section stayed coherent across the erase and completed'
  );
  assert.equal(reviews()[12].outcome, 'typed');

  // --- Something else writing to the file mid-review -----------------------
  // The old flow killed the review on any change it had not made itself. Now
  // the sections are re-anchored and the walk carries on, however many changes
  // arrive and wherever they land.
  const foreign = await review('foreign.ts');
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

  // --- The read-only lock option restores the strict behaviour -------------
  const config = () => vscode.workspace.getConfiguration('copyworkcode');
  await config().update('lockDuringReview', true, true);
  await settle();
  const locked = await review('locked.ts');
  await type('x');
  await settle(150);
  assert.equal(
    locked.getText(),
    'l1\nlocked\n',
    'with the lock on, a mismatched keystroke inserts nothing'
  );
  await exec('default:type', { text: '!' });
  await settle(150);
  assert.equal(
    locked.getText(),
    'l1\nlocked\n',
    'with the lock on, an edit off the matching path is inert too'
  );
  await typeAll('locked');
  await settle();
  assert.equal(baselineOf('locked.ts'), 'l1\nlocked\n');
  assert.equal(reviews()[16].outcome, 'typed');
  await config().update('lockDuringReview', undefined, true);
  await settle();
  // The lock has to lift when the review ends, or the file stays unwritable for
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
  await type('q'); // a real edit now, and the one that flashes
  await settle(150);
  assert.equal(animated.getText(), 'an1\naqn2\n');
  await config().update('animations', 'subtle', true);
  await settle();
  await type('n');
  await config().update('animations', 'off', true);
  await settle();
  await type('2');
  await settle();
  assert.equal(
    animated.getText(),
    'an1\naqn2\n',
    'animation frames never edit the buffer'
  );
  assert.equal(
    baselineOf('animated.ts'),
    'an1\naqn2\n',
    'the review completed across two animation level changes'
  );
  assert.equal(reviews().length, 19, 'the review survived the level changes');
  assert.equal(reviews()[18].hunksTyped, 1);
  await config().update('animations', undefined, true);
  await settle();

  // --- Keystrokes arriving faster than they can be answered ----------------
  // Fired without awaiting each one, which pins down what a burst has to
  // produce: matched keystrokes still edit nothing, and divergent ones land in
  // the order they were typed, each at its own offset. Commands driven from the
  // extension turn out to arrive sequentially, so this does not prove the
  // gesture queue is load-bearing — it fixes the behaviour a burst must have,
  // however the keystrokes get here.
  const fast = await review('fast.ts');
  await Promise.all([...'quick'].map((key) => type(key)));
  await settle();
  assert.equal(
    fast.getText(),
    'q1\nquick brown\n',
    'a burst of matched keystrokes still edits nothing'
  );
  await Promise.all([...'ABC'].map((key) => type(key)));
  await settle();
  assert.equal(
    fast.getText(),
    'q1\nquickABC brown\n',
    'a burst of divergent keystrokes lands in order, each at the right offset'
  );
  await exec('copyworkcode.skipSection');
  await settle();
  assert.equal(reviews().length, 20, 'the fast-typed review is recorded');

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
