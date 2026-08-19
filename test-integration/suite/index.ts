import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * End-to-end checks inside a live extension host: activation, the guided
 * retype flow driven by simulated keystrokes, section skip, whole-file skip,
 * word fills, abort, session teardown when the review editor closes, parking a
 * review to start another file and resuming it, changing the animation level
 * mid-review, and the git comparison mode.
 * Runs sequentially — one review is live at a time by design.
 */
export async function run(): Promise<void> {
  const ws = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const baselineOf = (name: string) =>
    fs.readFileSync(
      path.join(ws, '.copyworkcode', 'baselines', encodeURIComponent(name)),
      'utf8'
    );
  const stateFile = path.join(ws, '.copyworkcode', 'state.json');
  const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

  const ext = vscode.extensions.all.find((e) => e.id.endsWith('.copyworkcode'));
  assert.ok(ext, 'extension is present in the host');
  await ext.activate();
  assert.ok(ext.isActive, 'extension activates');

  const type = (text: string) =>
    vscode.commands.executeCommand('type', { text });

  // --- Full retype review ---------------------------------------------------
  const sample = path.join(ws, 'sample.ts');
  await vscode.commands.executeCommand('copyworkcode.reviewFile', sample);

  const doc = vscode.workspace.textDocuments.find(
    (d) => d.uri.fsPath === sample
  );
  assert.ok(doc, 'review opened the file');
  assert.equal(
    doc.getText(),
    'line1\nline2\nline3\n',
    'the buffer keeps its full content at review start'
  );
  assert.equal(doc.isDirty, false, 'starting a review never dirties the file');

  await type('x'); // wrong key
  assert.equal(
    doc.getText(),
    'line1\nline2\nline3\n',
    'mismatched keystroke changes nothing'
  );

  for (const key of ['l', 'i', 'n', 'e', '2']) {
    await type(key);
  }
  assert.equal(
    doc.getText(),
    'line1\nline2\nline3\n',
    'typing the section leaves the content byte-identical'
  );
  assert.equal(doc.isDirty, false, 'a completed review never dirties the file');
  assert.equal(
    baselineOf('sample.ts'),
    'line1\nline2\nline3\n',
    'baseline advanced after typed review'
  );

  let state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.reviews.length, 1);
  assert.equal(state.reviews[0].outcome, 'typed');
  assert.equal(state.reviews[0].hunksTyped, 1);

  // --- Skip section ----------------------------------------------------------
  const skipSection = path.join(ws, 'skipsection.ts');
  await vscode.commands.executeCommand('copyworkcode.reviewFile', skipSection);
  await vscode.commands.executeCommand('copyworkcode.skipSection');
  assert.equal(
    fs.readFileSync(skipSection, 'utf8'),
    'a\nb\n',
    'skipping a section leaves the content untouched'
  );
  assert.equal(baselineOf('skipsection.ts'), 'a\nb\n');
  state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.reviews[1].outcome, 'skipped');

  // --- Skip whole file from the tree ----------------------------------------
  const skipFile = path.join(ws, 'skipfile.ts');
  await vscode.commands.executeCommand('copyworkcode.skipFile', {
    resourceUri: vscode.Uri.file(skipFile),
  });
  assert.equal(baselineOf('skipfile.ts'), 'x\ny\n');
  state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.reviews[2].outcome, 'skipped');

  // --- Abort leaves the file untouched and the debt in place -----------------
  const aborted = path.join(ws, 'aborted.ts');
  await vscode.commands.executeCommand('copyworkcode.reviewFile', aborted);
  const abortedDoc = vscode.workspace.textDocuments.find(
    (d) => d.uri.fsPath === aborted
  );
  assert.ok(abortedDoc);
  await type('t');
  assert.equal(
    abortedDoc.getText(),
    'one\ntwo\n',
    'accepted keystrokes change nothing in the buffer'
  );
  await vscode.commands.executeCommand('copyworkcode.abortReview');
  assert.equal(abortedDoc.getText(), 'one\ntwo\n', 'abort has nothing to undo');
  assert.equal(abortedDoc.isDirty, false, 'abort leaves the file clean');
  assert.equal(baselineOf('aborted.ts'), 'one\n', 'abort leaves debt in place');
  state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.reviews.length, 3, 'abort records no review');

  // --- Doubled command invocation starts exactly one review ------------------
  const race = path.join(ws, 'race.ts');
  await Promise.all([
    vscode.commands.executeCommand('copyworkcode.reviewFile', race),
    vscode.commands.executeCommand('copyworkcode.reviewFile', race),
  ]);
  const raceDoc = vscode.workspace.textDocuments.find(
    (d) => d.uri.fsPath === race
  );
  assert.ok(raceDoc);
  for (const key of ['r', '2']) {
    await type(key);
  }
  assert.equal(baselineOf('race.ts'), 'r1\nr2\n');
  state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(
    state.reviews.length,
    4,
    'double invocation records a single review'
  );

  // --- Tab routes through the engine as whitespace ---------------------------
  const tabbed = path.join(ws, 'tabbed.ts');
  await vscode.commands.executeCommand('copyworkcode.reviewFile', tabbed);
  const tabbedDoc = vscode.workspace.textDocuments.find(
    (d) => d.uri.fsPath === tabbed
  );
  assert.ok(tabbedDoc);
  await vscode.commands.executeCommand('copyworkcode.typeTab');
  await type('x');
  assert.equal(
    tabbedDoc.getText(),
    'f\n\tx\n',
    'tab snaps the indentation and the section completes'
  );
  assert.equal(baselineOf('tabbed.ts'), 'f\n\tx\n');
  state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.reviews.length, 5, 'tabbed review is recorded');

  // --- Enter routes through the engine; raw edits bounce off read-only -------
  const entered = path.join(ws, 'entered.ts');
  await vscode.commands.executeCommand('copyworkcode.reviewFile', entered);
  const enteredDoc = vscode.workspace.textDocuments.find(
    (d) => d.uri.fsPath === entered
  );
  assert.ok(enteredDoc);
  // Regression for the review-killing popup: an editing gesture that reaches
  // the editor's default handler (as an unrebound Enter once did) must be
  // blocked by the session read-only flag, not edit the buffer and abort.
  await vscode.commands.executeCommand('default:type', { text: '!' });
  assert.equal(
    enteredDoc.getText(),
    'start\na\nb\n',
    'a default-path edit is inert during a review'
  );
  await type('a');
  await vscode.commands.executeCommand('copyworkcode.typeEnter');
  await type('b');
  assert.equal(baselineOf('entered.ts'), 'start\na\nb\n');
  state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.reviews.length, 6, 'the review survived the blocked edit');

  // --- A foreign change to the file aborts and keeps the new content ---------
  const reload = path.join(ws, 'reload.ts');
  await vscode.commands.executeCommand('copyworkcode.reviewFile', reload);
  const reloadDoc = vscode.workspace.textDocuments.find(
    (d) => d.uri.fsPath === reload
  );
  assert.ok(reloadDoc);
  fs.writeFileSync(reload, 'external\n');
  await vscode.commands.executeCommand('workbench.action.files.revert');
  await settle();
  assert.equal(
    reloadDoc.getText(),
    'external\n',
    'reloaded content is kept after the abort'
  );
  assert.equal(reloadDoc.isDirty, false, 'no stale content is resurrected');
  state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.reviews.length, 6, 'foreign-change abort records no review');

  // --- Closing the review editor tears the session down ----------------------
  // Regression for the wedge where an abandoned review blocked every future
  // one: close a review mid-flight, then run a full review of a *different*
  // file. If the first session leaked, the second never starts and these
  // assertions land on the wrong file.
  const closed = path.join(ws, 'closed.ts');
  await vscode.commands.executeCommand('copyworkcode.reviewFile', closed);
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  await settle();

  // --- A file created from scratch (empty baseline) reviews sanely -----------
  const fresh = path.join(ws, 'fresh.ts');
  const freshContent = 'created\nby agent\n';
  await vscode.commands.executeCommand('copyworkcode.reviewFile', fresh);
  const freshDoc = vscode.workspace.textDocuments.find(
    (d) => d.uri.fsPath === fresh
  );
  assert.ok(freshDoc, 'review of the fresh file opened');
  assert.equal(
    freshDoc.getText(),
    freshContent,
    'whole-file section stays fully visible at review start'
  );
  assert.equal(freshDoc.isDirty, false, 'whole-file review never dirties the file');
  await vscode.commands.executeCommand('copyworkcode.skipSection');
  assert.equal(baselineOf('fresh.ts'), freshContent);
  assert.equal(
    baselineOf('closed.ts'),
    'c1\n',
    'the abandoned review advanced nothing'
  );
  state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.reviews.length, 7, 'closing the editor records no review');
  assert.ok(
    state.reviews[6].file.endsWith('fresh.ts'),
    'the review after an abandoned one targets the right file'
  );

  // --- A deletion-only change is confirmed, not typed -------------------------
  const removed = path.join(ws, 'removed.ts');
  await vscode.commands.executeCommand('copyworkcode.reviewFile', removed);
  const removedDoc = vscode.workspace.textDocuments.find(
    (d) => d.uri.fsPath === removed
  );
  assert.ok(removedDoc, 'review of the deletion-only file opened');
  await type('x'); // typing has no target here and must not do anything
  assert.equal(removedDoc.getText(), 'keep\n');
  await vscode.commands.executeCommand('copyworkcode.confirmSection');
  assert.equal(
    baselineOf('removed.ts'),
    'keep\n',
    'confirming the deletion advanced the baseline'
  );
  state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.reviews.length, 8, 'confirmed deletion is recorded');
  assert.equal(state.reviews[7].outcome, 'typed');
  assert.equal(state.reviews[7].hunksConfirmed, 1);

  // --- The whole section filled word by word ---------------------------------
  const word = path.join(ws, 'word.ts');
  await vscode.commands.executeCommand('copyworkcode.reviewFile', word);
  const wordDoc = vscode.workspace.textDocuments.find(
    (d) => d.uri.fsPath === word
  );
  assert.ok(wordDoc);
  // 'const', ' sum', ' =', ' add', '(', 'a', ',', ' b', ');\n'
  for (let i = 0; i < 9; i++) {
    await vscode.commands.executeCommand('copyworkcode.fillNextWord');
  }
  assert.equal(
    wordDoc.getText(),
    'w1\nconst sum = add(a, b);\n',
    'filling words leaves the content byte-identical'
  );
  assert.equal(
    baselineOf('word.ts'),
    'w1\nconst sum = add(a, b);\n',
    'nine word fills completed the section'
  );
  state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.reviews.length, 9, 'the word-filled review is recorded');

  // --- Starting another file parks the first, which resumes where it was -----
  // Regression for the wedge that made every second file unreachable: moving
  // to another file must not need the first review to be stopped, and coming
  // back must not restart typing that was already done.
  const parked = path.join(ws, 'parked.ts');
  const other = path.join(ws, 'other.ts');
  await vscode.commands.executeCommand('copyworkcode.reviewFile', parked);
  for (const key of ['p', 'a', '2']) {
    await type(key);
  }
  await vscode.commands.executeCommand('copyworkcode.reviewFile', other);
  await settle();
  const otherDoc = vscode.workspace.textDocuments.find(
    (d) => d.uri.fsPath === other
  );
  assert.ok(otherDoc, 'the second file opened for review without a warning');
  await vscode.commands.executeCommand('copyworkcode.abortReview');
  assert.equal(baselineOf('other.ts'), 'ob1\n', 'the dropped review advanced nothing');

  await vscode.commands.executeCommand('copyworkcode.reviewFile', parked);
  await settle();
  // Resumed, so the section stands at "pa2" and wants its line break next. On
  // a restarted review these keystrokes would be rejected and the baseline
  // would stay put.
  await vscode.commands.executeCommand('copyworkcode.typeEnter');
  for (const key of ['p', 'a', '3']) {
    await type(key);
  }
  assert.equal(
    baselineOf('parked.ts'),
    'pa1\npa2\npa3\n',
    'the parked review resumed instead of starting over'
  );
  state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.reviews.length, 10, 'the resumed review is recorded once');
  assert.equal(state.reviews[9].hunksTyped, 1);

  // --- Comparing against git reaches files with no snapshot ------------------
  const gitOnly = path.join(ws, 'gitonly.ts');
  await vscode.commands.executeCommand('copyworkcode.reviewFile', gitOnly);
  await settle();
  assert.equal(
    vscode.workspace.textDocuments.some((d) => d.uri.fsPath === gitOnly),
    false,
    'with no snapshot behind it, the tracked queue has nothing to review'
  );

  await vscode.commands.executeCommand('copyworkcode.useGitBaseline');
  await settle();
  await vscode.commands.executeCommand('copyworkcode.reviewFile', gitOnly);
  const gitDoc = vscode.workspace.textDocuments.find(
    (d) => d.uri.fsPath === gitOnly
  );
  assert.ok(gitDoc, 'git mode reviews the change against the committed content');
  for (const key of ['g', '2']) {
    await type(key);
  }
  assert.equal(
    baselineOf('gitonly.ts'),
    'g1\ng2\n',
    'reviewing in git mode writes the snapshot, so the file leaves both queues'
  );
  state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.reviews.length, 11, 'the git-mode review is recorded');
  await vscode.commands.executeCommand('copyworkcode.useTrackedBaseline');
  await settle();

  // --- Changing the animation level mid-review does not disturb it -----------
  // The animation owns decoration types that are disposed and rebuilt when the
  // level changes; doing that under a live review must not touch the buffer,
  // the engine position, or the outcome.
  const animated = path.join(ws, 'animated.ts');
  const animations = () => vscode.workspace.getConfiguration('copyworkcode');
  await vscode.commands.executeCommand('copyworkcode.reviewFile', animated);
  const animatedDoc = vscode.workspace.textDocuments.find(
    (d) => d.uri.fsPath === animated
  );
  assert.ok(animatedDoc);
  await type('a');
  await type('q'); // mismatch: drives the reject animation
  await animations().update('animations', 'subtle', true);
  await settle();
  await type('n');
  await animations().update('animations', 'off', true);
  await settle();
  await type('2');
  assert.equal(
    animatedDoc.getText(),
    'an1\nan2\n',
    'animation frames never edit the buffer'
  );
  assert.equal(
    baselineOf('animated.ts'),
    'an1\nan2\n',
    'the review completed across two animation level changes'
  );
  state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.reviews.length, 12, 'the review survived the level changes');
  assert.equal(state.reviews[11].hunksTyped, 1);
  await animations().update('animations', undefined, true);
  await settle();

  // Typing must be back to normal once no review is active. Typed into a file
  // that was never a review editor, so this cannot pass or fail on whatever
  // the last section happened to leave focused.
  const plain = await vscode.workspace.openTextDocument(path.join(ws, 'skipfile.ts'));
  await vscode.window.showTextDocument(plain, { preview: false });
  await settle();
  await type('z');
  assert.ok(
    plain.getText().includes('z'),
    'default typing works after review ends'
  );

  // A review abandoned by closing its tab had no editor left to lift the
  // session read-only flag on; reopening the file must clear it on
  // activation, or the file would look locked for the rest of the session.
  const closedDoc = await vscode.workspace.openTextDocument(closed);
  await vscode.window.showTextDocument(closedDoc);
  await settle();
  await type('q');
  assert.ok(
    closedDoc.getText().includes('q'),
    'the file is writable again after an abandoned review'
  );

  console.log('copyworkcode integration suite: all checks passed');
}
