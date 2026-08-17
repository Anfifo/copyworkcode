import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { RetypeEngine } from '../src/core/retype';

function drive(engine: RetypeEngine, keys: string[]): string {
  let produced = '';
  for (const key of keys) {
    const result = engine.handleInput(key);
    if (result.kind === 'insert') {
      produced += result.text;
    }
  }
  return produced;
}

test('typing the exact target character by character completes it', () => {
  const engine = new RetypeEngine('ab');
  assert.deepEqual(engine.handleInput('a'), { kind: 'insert', text: 'a' });
  assert.equal(engine.done, false);
  assert.deepEqual(engine.handleInput('b'), { kind: 'insert', text: 'b' });
  assert.equal(engine.done, true);
});

test('wrong character is rejected and does not advance', () => {
  const engine = new RetypeEngine('ab');
  assert.deepEqual(engine.handleInput('x'), { kind: 'reject' });
  assert.equal(engine.position, 0);
});

test('any whitespace key snaps to the target whitespace run', () => {
  const engine = new RetypeEngine('a\n  b');
  engine.handleInput('a');
  // space pressed where target has newline + indent: whole run is applied
  assert.deepEqual(engine.handleInput(' '), { kind: 'insert', text: '\n  ' });
  assert.deepEqual(engine.handleInput('b'), { kind: 'insert', text: 'b' });
  assert.equal(engine.done, true);
});

test('enter pressed where target has a space also snaps', () => {
  const engine = new RetypeEngine('a b');
  engine.handleInput('a');
  assert.deepEqual(engine.handleInput('\n'), { kind: 'insert', text: ' ' });
});

test('whitespace key with no whitespace ahead is rejected', () => {
  const engine = new RetypeEngine('ab');
  engine.handleInput('a');
  assert.deepEqual(engine.handleInput(' '), { kind: 'reject' });
});

test('typing the next visible character auto-applies pending whitespace', () => {
  const engine = new RetypeEngine('a\n  b');
  engine.handleInput('a');
  assert.deepEqual(engine.handleInput('b'), { kind: 'insert', text: '\n  b' });
  assert.equal(engine.done, true);
});

test('multi-character input (paste, completion) is rejected', () => {
  const engine = new RetypeEngine('abc');
  assert.deepEqual(engine.handleInput('abc'), { kind: 'reject' });
  assert.equal(engine.position, 0);
});

test('input after completion is rejected', () => {
  const engine = new RetypeEngine('a');
  engine.handleInput('a');
  assert.deepEqual(engine.handleInput('a'), { kind: 'reject' });
});

test('fillLine completes the current line including its newline', () => {
  const engine = new RetypeEngine('abc\ndef\n');
  engine.handleInput('a');
  assert.equal(engine.fillLine(), 'bc\n');
  assert.equal(engine.remaining, 'def\n');
  assert.equal(engine.fillLine(), 'def\n');
  assert.equal(engine.done, true);
});

test('fillRest completes everything (skip section)', () => {
  const engine = new RetypeEngine('abc\ndef');
  engine.handleInput('a');
  assert.equal(engine.fillRest(), 'bc\ndef');
  assert.equal(engine.done, true);
});

test('trailing whitespace is absorbed by the last visible character', () => {
  const engine = new RetypeEngine('a}\n');
  engine.handleInput('a');
  assert.deepEqual(engine.handleInput('}'), { kind: 'insert', text: '}\n' });
  assert.equal(engine.done, true);
});

test('a full realistic hunk can be typed out', () => {
  const target = 'function add(a, b) {\n  return a + b;\n}\n';
  const engine = new RetypeEngine(target);
  const keys: string[] = [];
  for (const ch of target) {
    if (/\s/.test(ch)) continue; // user never has to type exact whitespace
    keys.push(ch);
  }
  const produced = drive(engine, keys);
  assert.equal(engine.done, true);
  assert.equal(produced, target);
});

test('CRLF targets reproduce CRLF exactly via snapping', () => {
  const target = 'a\r\nb\r\n';
  const engine = new RetypeEngine(target);
  let produced = '';
  for (const key of ['a', '\n', 'b']) {
    const r = engine.handleInput(key);
    assert.equal(r.kind, 'insert');
    if (r.kind === 'insert') produced += r.text;
  }
  assert.equal(produced, target);
  assert.equal(engine.done, true);
});
