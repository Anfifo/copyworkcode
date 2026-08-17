import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * End-to-end checks inside a live extension host: activation, the guided
 * retype flow driven by simulated keystrokes, section skip, whole-file skip,
 * and abort. Runs sequentially — the review flow is single-session by design.
 */
export async function run(): Promise<void> {
  const ws = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const baselineOf = (name: string) =>
    fs.readFileSync(
      path.join(ws, '.copyworkcode', 'baselines', encodeURIComponent(name)),
      'utf8'
    );
  const stateFile = path.join(ws, '.copyworkcode', 'state.json');

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
    'line1\nline3\n',
    'pending section is emptied for retyping'
  );

  await type('x'); // wrong key
  assert.equal(
    doc.getText(),
    'line1\nline3\n',
    'mismatched keystroke inserts nothing'
  );

  for (const key of ['l', 'i', 'n', 'e', '2']) {
    await type(key);
  }
  assert.equal(
    doc.getText(),
    'line1\nline2\nline3\n',
    'typing the section restores the exact content'
  );
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
    'skipping a section restores its content'
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

  // --- Abort restores content and leaves debt --------------------------------
  const aborted = path.join(ws, 'aborted.ts');
  await vscode.commands.executeCommand('copyworkcode.reviewFile', aborted);
  const abortedDoc = vscode.workspace.textDocuments.find(
    (d) => d.uri.fsPath === aborted
  );
  assert.ok(abortedDoc);
  await type('t');
  assert.equal(abortedDoc.getText(), 'one\nt');
  await vscode.commands.executeCommand('copyworkcode.abortReview');
  assert.equal(
    abortedDoc.getText(),
    'one\ntwo\n',
    'abort restores the full content'
  );
  assert.equal(baselineOf('aborted.ts'), 'one\n', 'abort leaves debt in place');
  state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.reviews.length, 3, 'abort records no review');

  // Typing must be back to normal once no review is active.
  const editor = vscode.window.activeTextEditor;
  assert.ok(editor);
  await type('z');
  assert.ok(
    editor.document.getText().includes('z'),
    'default typing works after review ends'
  );

  console.log('copyworkcode integration suite: all checks passed');
}
