import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { isSensitivePath } from '../src/core/sensitive';

const BACKSLASH = String.fromCharCode(92);

test('key material and credential stores are excluded', () => {
  for (const file of [
    '.env',
    '.env.local',
    '.env.production',
    'config/staging.env',
    'secrets.json',
    'deploy/secrets.yaml',
    'credentials',
    'aws/credentials.ini',
    'id_rsa',
    'id_ed25519.pub',
    '.npmrc',
    '.netrc',
    'certs/server.pem',
    'certs/server.key',
    'keys/bundle.p12',
    'vault.kdbx',
  ]) {
    assert.equal(isSensitivePath(file), true, `expected excluded: ${file}`);
  }
});

test('anything under a key directory is excluded', () => {
  assert.equal(isSensitivePath('.ssh/config'), true);
  assert.equal(isSensitivePath('home/.gnupg/pubring.kbx'), true);
  assert.equal(isSensitivePath('.aws/anything.txt'), true);
});

test('ordinary source files are not excluded', () => {
  for (const file of [
    'src/environment.ts',
    'src/env.d.ts',
    'src/secretsanta.ts',
    'src/keyboard.ts',
    'test/keys.test.ts',
    'docs/design.md',
    'package.json',
    'Makefile',
  ]) {
    assert.equal(isSensitivePath(file), false, `expected allowed: ${file}`);
  }
});

test('the secret/credential rule spares code and catches config', () => {
  // Code that handles secrets is worth reviewing; the data file beside it is not.
  assert.equal(isSensitivePath('src/secrets.ts'), false);
  assert.equal(isSensitivePath('src/credentials.js'), false);
  assert.equal(isSensitivePath('test/secrets.test.ts'), false);
  assert.equal(isSensitivePath('config/secrets.json'), true);
  assert.equal(isSensitivePath('.secrets'), true);
  assert.equal(isSensitivePath('my-credentials.toml'), true);
});

test('matching is case-insensitive and separator-agnostic', () => {
  assert.equal(isSensitivePath(`Config${BACKSLASH}Secrets.JSON`), true);
  assert.equal(isSensitivePath('config/.ENV'), true);
  assert.equal(isSensitivePath(`.SSH${BACKSLASH}id_rsa`), true);
});

test('an empty path is not sensitive', () => {
  assert.equal(isSensitivePath(''), false);
});
