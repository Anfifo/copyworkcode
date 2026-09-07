import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  HOME_ENV,
  canonicalRoot,
  dataHome,
  forgetWorkspace,
  isRegistered,
  registerWorkspace,
  registeredRootFor,
  workspaceDir,
  workspaceKey,
} from '../src/core/dataHome';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Every test gets a data home of its own, so nothing touches the real one. */
function isolatedHome(): string {
  const home = tempDir('cwc-home-');
  process.env[HOME_ENV] = home;
  return home;
}

test('the data home defaults to a folder in the user home', () => {
  delete process.env[HOME_ENV];
  assert.equal(dataHome(), path.join(os.homedir(), '.copyworkcode'));
});

test('the environment relocates the data home', () => {
  const home = isolatedHome();
  assert.equal(dataHome(), home);
});

test('one folder has one key, however it is spelled', () => {
  const root = tempDir('cwc-root-');
  const key = workspaceKey(root);
  assert.equal(workspaceKey(root + path.sep), key);
  assert.equal(workspaceKey(path.join(root, 'sub', '..')), key);
  assert.equal(workspaceKey(path.relative(process.cwd(), root)), key);
  if (process.platform === 'win32') {
    assert.equal(workspaceKey(root.toUpperCase()), key);
    assert.equal(workspaceKey(root.replace(/\\/g, '/')), key);
  }
});

test('different folders have different keys', () => {
  const a = tempDir('cwc-a-');
  const b = tempDir('cwc-b-');
  assert.notEqual(workspaceKey(a), workspaceKey(b));
});

test('the canonical form uses forward slashes and no trailing separator', () => {
  const root = tempDir('cwc-canon-');
  const canonical = canonicalRoot(root + path.sep);
  assert.equal(canonical.includes('\\'), false);
  assert.equal(canonical.endsWith('/'), false);
});

test('a workspace is registered under the data home with its path in clear', () => {
  const home = isolatedHome();
  const root = tempDir('cwc-reg-');
  assert.equal(isRegistered(root), false);

  registerWorkspace(root);
  assert.equal(isRegistered(root), true);
  assert.equal(path.dirname(path.dirname(workspaceDir(root))), home);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(workspaceDir(root), 'workspace.json'), 'utf8')
  );
  assert.equal(manifest.path, path.resolve(root));
  assert.ok(manifest.since);
});

test('registering twice keeps the first record', () => {
  isolatedHome();
  const root = tempDir('cwc-twice-');
  registerWorkspace(root);
  const first = fs.readFileSync(path.join(workspaceDir(root), 'workspace.json'), 'utf8');
  registerWorkspace(root);
  const second = fs.readFileSync(path.join(workspaceDir(root), 'workspace.json'), 'utf8');
  assert.equal(second, first);
});

test('forgetting removes the folder and everything in it', () => {
  isolatedHome();
  const root = tempDir('cwc-forget-');
  registerWorkspace(root);
  fs.mkdirSync(path.join(workspaceDir(root), 'baselines'));
  fs.writeFileSync(path.join(workspaceDir(root), 'baselines', 'a.ts'), 'x\n');

  forgetWorkspace(root);
  assert.equal(fs.existsSync(workspaceDir(root)), false);
  assert.equal(isRegistered(root), false);
});

test('forgetting a workspace that was never registered is a no-op', () => {
  isolatedHome();
  const root = tempDir('cwc-never-');
  assert.doesNotThrow(() => forgetWorkspace(root));
});

test('a folder inside a registered workspace resolves to that workspace', () => {
  isolatedHome();
  const root = tempDir('cwc-walk-');
  const nested = path.join(root, 'packages', 'app');
  fs.mkdirSync(nested, { recursive: true });
  registerWorkspace(root);

  assert.equal(registeredRootFor(nested), path.resolve(root));
  assert.equal(registeredRootFor(root), path.resolve(root));
});

test('the nearest registered workspace wins over an outer one', () => {
  isolatedHome();
  const outer = tempDir('cwc-outer-');
  const inner = path.join(outer, 'inner');
  fs.mkdirSync(inner);
  registerWorkspace(outer);
  registerWorkspace(inner);

  assert.equal(registeredRootFor(path.join(inner, 'src')), path.resolve(inner));
});

test('a folder under no registered workspace resolves to nothing', () => {
  isolatedHome();
  const root = tempDir('cwc-none-');
  assert.equal(registeredRootFor(root), undefined);
});
