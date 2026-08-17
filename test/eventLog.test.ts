import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseEventChunk } from '../src/core/eventLog';

const event = (id: string) =>
  JSON.stringify({ id, timestamp: 't', source: 'agent-hook', file: '/f' });

test('parses complete lines and keeps the partial tail', () => {
  const seen = new Set<string>();
  const chunk = `${event('1')}\n${event('2')}\n{"id":"3"`;
  const result = parseEventChunk(chunk, '', seen);
  assert.deepEqual(result.events.map((e) => e.id), ['1', '2']);
  assert.equal(result.remainder, '{"id":"3"');
});

test('remainder joins with the next chunk', () => {
  const seen = new Set<string>();
  const first = parseEventChunk('{"id":"1","file":"/f","times', '', seen);
  const second = parseEventChunk('tamp":"t","source":"agent-hook"}\n', first.remainder, seen);
  assert.deepEqual(second.events.map((e) => e.id), ['1']);
});

test('duplicate ids and corrupt lines are dropped', () => {
  const seen = new Set<string>();
  const chunk = `${event('1')}\nnot json\n${event('1')}\n${event('2')}\n`;
  const result = parseEventChunk(chunk, '', seen);
  assert.deepEqual(result.events.map((e) => e.id), ['1', '2']);
});

test('events without id or file are dropped', () => {
  const seen = new Set<string>();
  const chunk = '{"file":"/f"}\n{"id":"x"}\n';
  const result = parseEventChunk(chunk, '', seen);
  assert.deepEqual(result.events, []);
});
