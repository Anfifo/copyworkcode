#!/usr/bin/env node
'use strict';

// MCP server the agent starts over stdio. It offers one tool, flag_for_review,
// which the agent calls after an edit to point the reviewer at a part of its
// change worth typing out, with the reason and the intent behind it. Each call
// appends one line to the workspace's flags.jsonl under the data home, which
// the extension watches.
//
// The tool is offered only in a workspace where CopyWorkCode is enabled, so a
// session anywhere else carries neither the tool nor its instructions. The
// server is registered for every project at user scope for the same reason the
// capture hook is: one entry, and silence wherever it was not asked for.
//
// A flag only adds to a review (see src/core/flags.ts). The server checks that
// the excerpt is in the file as it is now, and once only, so the review can
// find it again; anything else the agent sends back is answered as an error
// it can act on.
//
// Plain Node with no package dependencies, like the hook. The rules it shares
// with the extension come from the compiled core next to it.

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const core = (name) => require(path.join(__dirname, '..', 'out', 'core', name));
const { registeredRootFor } = core('dataHome');
const { flagsPath } = core('paths');
const { baselineKey } = core('baselineStore');
const { isSensitivePath } = core('sensitive');
const { IMPORTANCE, occurrences } = core('flags');

const VERSION = require(path.join(__dirname, '..', 'package.json')).version;
const TOOL = 'flag_for_review';
const MAX_EXCERPT = 20000;
const MAX_TEXT = 1000;

// The agent sets this for the servers it starts; the working directory is the
// same folder in practice and covers an agent that does not.
const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

const INSTRUCTIONS = [
  'CopyWorkCode is enabled in this workspace: the user reviews your file changes by',
  'retyping them. After a set of edits, call flag_for_review for each part of your',
  'change that most deserves close reading: security- or data-sensitive logic, error',
  'handling, concurrency, a non-obvious decision, or anything you are unsure of. Quote',
  'the excerpt verbatim from the file as it is now. Leave out imports, boilerplate and',
  'mechanical changes. A flag adds emphasis only: everything you changed is still',
  'reviewed.',
].join(' ');

const TOOL_SPEC = {
  name: TOOL,
  description:
    'Point the reviewer at part of a change you just made that is worth typing out ' +
    'carefully, with why. Call it after editing, once per part. It never exempts ' +
    'anything from review.',
  inputSchema: {
    type: 'object',
    properties: {
      file: {
        type: 'string',
        description: 'Path of the edited file, absolute or relative to the project.',
      },
      excerpt: {
        type: 'string',
        description: 'Verbatim text from the file as it is now, long enough to occur once.',
      },
      importance: {
        type: 'string',
        enum: IMPORTANCE,
        description:
          'must-type for what the reviewer has to read closely; worth-typing for the rest.',
      },
      reason: {
        type: 'string',
        description: 'One sentence: why this part deserves attention.',
      },
      intent: {
        type: 'string',
        description: 'Optional: what this part of the change is for.',
      },
    },
    required: ['file', 'excerpt', 'importance', 'reason'],
  },
};

function enabledRoot() {
  return registeredRootFor(projectDir);
}

function done(message) {
  return { content: [{ type: 'text', text: message }], isError: false };
}

function refuse(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function lineOf(content, offset) {
  let line = 1;
  for (let i = 0; i < offset; i++) if (content[i] === '\n') line++;
  return line;
}

function trimmed(value) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, MAX_TEXT) : '';
}

function flag(args) {
  const root = enabledRoot();
  if (!root) return refuse('CopyWorkCode is not enabled in this workspace. Nothing was flagged.');
  const { file, excerpt, importance } = args || {};
  const reason = trimmed(args && args.reason);
  if (typeof file !== 'string' || !file) return refuse('file is required.');
  if (typeof excerpt !== 'string' || !excerpt.trim()) return refuse('excerpt is required.');
  if (excerpt.length > MAX_EXCERPT) {
    return refuse('The excerpt is too long. Quote the part that matters.');
  }
  if (!IMPORTANCE.includes(importance)) {
    return refuse(`importance must be one of ${IMPORTANCE.join(', ')}.`);
  }
  if (!reason) return refuse('reason is required.');

  const absolute = path.resolve(projectDir, file);
  if (baselineKey(root, absolute) === undefined) {
    return refuse(`${file} is outside the workspace.`);
  }
  const rel = path.relative(root, absolute).replace(/\\/g, '/');
  if (isSensitivePath(rel)) {
    return refuse(`${rel} is a credentials file, never reviewed by typing. Do not flag it.`);
  }

  let content;
  try {
    content = fs.readFileSync(absolute, 'utf8');
  } catch {
    return refuse(`${rel} could not be read.`);
  }
  const hits = occurrences(content, excerpt);
  if (hits.length === 0) {
    return refuse(`The excerpt is not in ${rel} as it is now. Quote it from the current file.`);
  }
  if (hits.length > 1) {
    return refuse(
      `The excerpt occurs ${hits.length} times in ${rel}. ` +
        'Quote more of the surrounding lines so it occurs once.'
    );
  }

  const intent = trimmed(args.intent);
  const record = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    file: absolute,
    excerpt,
    offset: hits[0].at,
    importance,
    reason,
    ...(intent ? { intent } : {}),
  };
  fs.mkdirSync(path.dirname(flagsPath(root)), { recursive: true });
  fs.appendFileSync(flagsPath(root), JSON.stringify(record) + '\n');
  const first = lineOf(content, hits[0].at);
  const last = lineOf(content, hits[0].at + hits[0].length - 1);
  const lines = first === last ? `line ${first}` : `lines ${first}-${last}`;
  return done(`Flagged ${lines} of ${rel} as ${importance}.`);
}

function handle(method, params) {
  switch (method) {
    case 'initialize': {
      const enabled = enabledRoot() !== undefined;
      return {
        // The one tool uses nothing that differs between protocol versions,
        // so the client's version is the answer.
        protocolVersion: params.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'copyworkcode', version: VERSION },
        ...(enabled ? { instructions: INSTRUCTIONS } : {}),
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: enabledRoot() ? [TOOL_SPEC] : [] };
    case 'tools/call':
      if (params.name !== TOOL) throw rpcError(-32602, `Unknown tool: ${params.name}`);
      return flag(params.arguments);
    default:
      throw rpcError(-32601, `Method not found: ${method}`);
  }
}

function rpcError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function send(payload) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...payload }) + '\n');
}

const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  // A notification gets no answer, whatever it is.
  const isRequest = message.id !== undefined && message.id !== null;
  try {
    const result = handle(message.method, message.params || {});
    if (isRequest) send({ id: message.id, result });
  } catch (err) {
    const error = { code: err.code || -32603, message: String(err.message) };
    if (isRequest) send({ id: message.id, error });
  }
});
input.on('close', () => process.exit(0));
