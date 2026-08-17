import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

/**
 * Boots a real editor instance against a fixture workspace that already has
 * baselines and pending debt, then runs the suite in the extension host.
 */
async function main(): Promise<void> {
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
  if (state.reviews.length !== 3) {
    throw new Error(
      `expected 3 review records in the fixture, found ${state.reviews.length}`
    );
  }
  const advanced = fs.readFileSync(path.join(baselines, 'sample.ts'), 'utf8');
  if (advanced !== 'line1\nline2\nline3\n') {
    throw new Error('sample.ts baseline was not advanced by the typed review');
  }
  console.log('Integration suite side effects verified.');
}

main().catch((err) => {
  console.error('Integration tests failed:', err);
  process.exit(1);
});
