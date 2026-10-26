import { strict as assert } from 'assert';
import { test } from 'node:test';
import { SERVER_NAME, describeServer, serverSpec } from '../src/core/flagServerConfig';

const OURS = '/ext/1.0.0/mcp/copyworkcode-mcp.js';
const MOVED = '/ext/0.9.0/mcp/copyworkcode-mcp.js';

test('serverSpec runs the script with node over stdio', () => {
  assert.deepEqual(serverSpec(OURS), { type: 'stdio', command: 'node', args: [OURS] });
});

test('describeServer reads an entry registered from this install', () => {
  const config = { projects: {}, mcpServers: { [SERVER_NAME]: serverSpec(OURS) } };
  assert.deepEqual(describeServer(config, OURS), {
    registered: true,
    current: true,
    script: OURS,
  });
});

test('describeServer sees an entry from another install as ours but stale', () => {
  const config = { mcpServers: { [SERVER_NAME]: serverSpec(MOVED) } };
  assert.deepEqual(describeServer(config, OURS), {
    registered: true,
    current: false,
    script: MOVED,
  });
});

test('an entry under our name that runs something else is not ours', () => {
  const config = {
    mcpServers: { [SERVER_NAME]: { type: 'stdio', command: 'npx', args: ['other-server'] } },
  };
  assert.deepEqual(describeServer(config, OURS), { registered: true, current: false });
});

test('describeServer tolerates any shape', () => {
  const shapes = [
    undefined,
    null,
    [],
    'x',
    {},
    { mcpServers: [] },
    { mcpServers: { [SERVER_NAME]: 3 } },
  ];
  for (const config of shapes) {
    assert.deepEqual(describeServer(config, OURS), { registered: false, current: false });
  }
});
