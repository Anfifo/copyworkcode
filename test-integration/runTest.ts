import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { runTests } from '@vscode/test-electron';

/**
 * Boots a real editor instance against a fixture workspace that already has
 * baselines and pending debt, then runs the suite in the extension host. One
 * file per interesting review case, including the ones about the line between
 * an armed review and an editable one: pressing the wrong key, hand-writing
 * code, erasing, and something else writing to the file mid-review.
 */
async function main(): Promise<void> {
  // Inherited from editor-integrated terminals; it makes the spawned test
  // editor start as a plain Node process instead of booting the workbench.
  delete process.env.ELECTRON_RUN_AS_NODE;

  const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
  const extensionTestsPath = path.resolve(__dirname, 'suite');

  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'cwc-fixture-'));
  const baselines = path.join(fixture, '.copyworkcode', 'baselines');
  fs.mkdirSync(baselines, { recursive: true });

  // Reviewed by typing in the suite.
  fs.writeFileSync(path.join(fixture, 'sample.ts'), 'line1\nline2\nline3\n');
  fs.writeFileSync(path.join(baselines, 'sample.ts'), 'line1\nline3\n');
  // Reviewed via skip-section.
  fs.writeFileSync(path.join(fixture, 'skipsection.ts'), 'a\nb\n');
  fs.writeFileSync(path.join(baselines, 'skipsection.ts'), 'a\n');
  // Skipped whole-file from the tree context menu.
  fs.writeFileSync(path.join(fixture, 'skipfile.ts'), 'x\ny\n');
  fs.writeFileSync(path.join(baselines, 'skipfile.ts'), 'x\n');
  // Review started and aborted.
  fs.writeFileSync(path.join(fixture, 'aborted.ts'), 'one\ntwo\n');
  fs.writeFileSync(path.join(baselines, 'aborted.ts'), 'one\n');
  // Review command fired twice for one gesture (double-click).
  fs.writeFileSync(path.join(fixture, 'race.ts'), 'r1\nr2\n');
  fs.writeFileSync(path.join(baselines, 'race.ts'), 'r1\n');
  // Indented section part-filled with the tab key and part typed.
  fs.writeFileSync(path.join(fixture, 'tabbed.ts'), 'f\n\tx = y;\n');
  fs.writeFileSync(path.join(baselines, 'tabbed.ts'), 'f\n');
  // A raw edit command, refused while armed and applied once editing is on,
  // then the rest typed with the enter key between lines.
  fs.writeFileSync(path.join(fixture, 'entered.ts'), 'start\na\nb\n');
  fs.writeFileSync(path.join(baselines, 'entered.ts'), 'start\n');
  // File reloaded from disk mid-review.
  fs.writeFileSync(path.join(fixture, 'reload.ts'), 'a\nb\n');
  fs.writeFileSync(path.join(baselines, 'reload.ts'), 'a\n');
  // Buffer replaced wholesale mid-review: the sections are re-derived.
  fs.writeFileSync(path.join(fixture, 'replaced.ts'), 'p1\np2\n');
  fs.writeFileSync(path.join(baselines, 'replaced.ts'), 'p1\n');
  // Opens on a deletion: the first section has nothing in it to type.
  fs.writeFileSync(path.join(fixture, 'deletionfirst.ts'), 'a\nc\nNEW\n');
  fs.writeFileSync(path.join(baselines, 'deletionfirst.ts'), 'a\nb\nc\n');
  // Wrong keys that must not reach the file, then one that is asked for.
  fs.writeFileSync(path.join(fixture, 'wrongkey.ts'), 'd1\nORIGINAL\n');
  fs.writeFileSync(path.join(baselines, 'wrongkey.ts'), 'd1\n');
  // Typed, erased with backspace once editing is on, then typed to the end.
  fs.writeFileSync(path.join(fixture, 'backspace.ts'), 'b1\nbeta\n');
  fs.writeFileSync(path.join(baselines, 'backspace.ts'), 'b1\n');
  // Written to from outside the review flow while the review is live.
  fs.writeFileSync(
    path.join(fixture, 'foreign.ts'),
    'f1\nalpha\nf3\nbeta\nf5\n'
  );
  fs.writeFileSync(path.join(baselines, 'foreign.ts'), 'f1\nf3\nf5\n');
  // Clicked into the middle of what the section owes, then typed.
  fs.writeFileSync(path.join(fixture, 'inbox.ts'), 'i1\ninside the box\n');
  fs.writeFileSync(path.join(baselines, 'inbox.ts'), 'i1\n');
  // Two sections claimed out of order, starting with the second.
  fs.writeFileSync(path.join(fixture, 'roam.ts'), 'r1\none\nr3\ntwo\nr5\n');
  fs.writeFileSync(path.join(baselines, 'roam.ts'), 'r1\nr3\nr5\n');
  // Keystrokes fired without waiting for the extension to answer the previous
  // one, which is how the editor really dispatches them.
  fs.writeFileSync(path.join(fixture, 'fast.ts'), 'q1\nquick brown\n');
  fs.writeFileSync(path.join(baselines, 'fast.ts'), 'q1\n');
  // Reviewed start to finish, to check the read-only flag lifts afterwards.
  fs.writeFileSync(path.join(fixture, 'locked.ts'), 'l1\nlocked\n');
  fs.writeFileSync(path.join(baselines, 'locked.ts'), 'l1\n');
  // Review abandoned by closing the review editor.
  fs.writeFileSync(path.join(fixture, 'closed.ts'), 'c1\nc2\n');
  fs.writeFileSync(path.join(baselines, 'closed.ts'), 'c1\n');
  // File created from scratch: baseline exists but is empty.
  fs.writeFileSync(path.join(fixture, 'fresh.ts'), 'created\nby agent\n');
  fs.writeFileSync(path.join(baselines, 'fresh.ts'), '');
  // Deletion-only change: nothing to retype, acknowledged with one action.
  fs.writeFileSync(path.join(fixture, 'removed.ts'), 'keep\n');
  fs.writeFileSync(path.join(baselines, 'removed.ts'), 'keep\ngone\n');
  // A removal with text worth showing: what the hover behind the mark holds.
  fs.writeFileSync(path.join(fixture, 'deleted.ts'), 'keep\ntail\n');
  fs.writeFileSync(
    path.join(baselines, 'deleted.ts'),
    'keep\nfirst gone\nsecond gone\ntail\n'
  );
  // A deletion confirmed while the review carries on: the mark, and the hover
  // behind it, go quiet with the section rather than outliving it.
  fs.writeFileSync(path.join(fixture, 'cleared.ts'), 'k1\nk3\nadded\n');
  fs.writeFileSync(path.join(baselines, 'cleared.ts'), 'k1\ngone\nk3\n');
  // Clicked back into text already typed, which is a click into the section
  // like any other: the caret goes to where the typing goes.
  fs.writeFileSync(path.join(fixture, 'retouch.ts'), 't1\nabcdef\n');
  fs.writeFileSync(path.join(baselines, 'retouch.ts'), 't1\n');
  // Reset partway through, with nothing written by hand to discard.
  fs.writeFileSync(path.join(fixture, 'resetme.ts'), 's1\nsecond\nthird\n');
  fs.writeFileSync(path.join(baselines, 'resetme.ts'), 's1\n');
  // Reviewed with the fill-next-word control only.
  fs.writeFileSync(path.join(fixture, 'word.ts'), 'w1\nconst sum = add(a, b);\n');
  fs.writeFileSync(path.join(baselines, 'word.ts'), 'w1\n');
  // Review parked partway through by opening another file, written into while
  // it waits, then resumed and finished.
  fs.writeFileSync(path.join(fixture, 'parked.ts'), 'pa1\npa2\npa3\n');
  fs.writeFileSync(path.join(baselines, 'parked.ts'), 'pa1\n');
  // The other file: reviewed while the one above waits, then parked in its turn.
  fs.writeFileSync(path.join(fixture, 'other.ts'), 'ob1\nob2\n');
  fs.writeFileSync(path.join(baselines, 'other.ts'), 'ob1\n');
  // Reviewed with `startEditing` on: editable from the first keystroke.
  fs.writeFileSync(path.join(fixture, 'startedit.ts'), 'e1\nedited\n');
  fs.writeFileSync(path.join(baselines, 'startedit.ts'), 'e1\n');
  // Retyped while the animation level is changed underneath the live review.
  fs.writeFileSync(path.join(fixture, 'animated.ts'), 'an1\nan2\n');
  fs.writeFileSync(path.join(baselines, 'animated.ts'), 'an1\n');

  // Only visible when comparing against git: committed, then changed, with no
  // snapshot behind it — the case the tracked queue cannot see at all.
  fs.writeFileSync(path.join(fixture, 'gitonly.ts'), 'g1\n');
  commitFixture(fixture);
  fs.writeFileSync(path.join(fixture, 'gitonly.ts'), 'g1\ng2\n');

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [fixture, '--disable-extensions', '--disable-workspace-trust'],
  });

  // Belt and braces: verify the suite's side effects from outside the editor
  // process, so a suite that silently failed to run cannot pass.
  const state = JSON.parse(
    fs.readFileSync(path.join(fixture, '.copyworkcode', 'state.json'), 'utf8')
  );
  if (state.reviews.length !== 23) {
    throw new Error(
      `expected 23 review records in the fixture, found ${state.reviews.length}`
    );
  }
  const advanced = fs.readFileSync(path.join(baselines, 'sample.ts'), 'utf8');
  if (advanced !== 'line1\nline2\nline3\n') {
    throw new Error('sample.ts baseline was not advanced by the typed review');
  }
  console.log('Integration suite side effects verified.');
}

/**
 * Turns the fixture into a repository with one commit, so the suite can drive
 * the git comparison mode. The runtime data directory is excluded the same way
 * enabling a workspace excludes it, keeping it out of the git-mode queue.
 */
function commitFixture(fixture: string): void {
  const git = (...args: string[]): void => {
    const done = spawnSync('git', args, { cwd: fixture, encoding: 'utf8' });
    if (done.status !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${done.stderr ?? done.error}`);
    }
  };
  git('init', '-q');
  git('config', 'user.email', 'fixture@example.com');
  git('config', 'user.name', 'Fixture');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(fixture, '.git', 'info', 'exclude'), '.copyworkcode/\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
}

main().catch((err) => {
  console.error('Integration tests failed:', err);
  process.exit(1);
});
