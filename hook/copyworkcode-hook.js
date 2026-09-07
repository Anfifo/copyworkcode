#!/usr/bin/env node
'use strict';

// Claude Code hook installed for both PreToolUse and PostToolUse on file
// tools. Receives the tool event as JSON on stdin.
//
// - PreToolUse: snapshot the file's current content into
//   <cwd>/.copyworkcode/baselines/ if no baseline exists yet, preserving the
//   pre-change state the review diff needs (the file is about to change).
// - PostToolUse: append a change event to <cwd>/.copyworkcode/events.jsonl.
//
// Three hard requirements shape this file:
// - It only records in workspaces that opted in (the data directory exists),
//   so it is safe to install at user scope for all projects.
// - It never copies the content of a credentials file, in either direction:
//   no baseline snapshot and no text in the event. The occurrence is still
//   recorded, so an agent touching one is visible, but the secret is not
//   duplicated into the workspace data directory.
// - It must never disturb the agent session: any failure exits 0 silently.
//   Plain Node, no dependencies, so it runs wherever the agent runs.

const fs = require('fs');
const path = require('path');

const FILE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

// Files whose content is never copied anywhere. This mirrors the pattern list
// in src/core/sensitive.ts, which carries the reasoning and the tests; the two
// must stay in sync. Reimplemented here because this script runs standalone,
// with no build step and no dependencies.
const SENSITIVE_NAMES = [
  /^\.env(\.|$)/,
  /\.env$/,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /^\.(npmrc|netrc|pgpass|htpasswd)$/,
  /\.(pem|key|p12|pfx|jks|keystore|asc|gpg|kdbx)$/,
];
const SENSITIVE_DATA_NAMES = [
  /(^|[._-])secrets?([._-]|$)/,
  /(^|[._-])credentials?([._-]|$)/,
];
const DATA_EXTENSIONS = new Set([
  '', 'json', 'jsonc', 'yaml', 'yml', 'ini', 'toml', 'cfg', 'conf', 'config',
  'properties', 'txt', 'xml', 'csv', 'tfvars', 'plist', 'enc',
]);
const SENSITIVE_DIRS = new Set(['.ssh', '.gnupg', '.aws', '.gcloud', '.azure']);

function isSensitive(cwd, file) {
  const rel = path.relative(cwd, file).toLowerCase();
  const name = path.basename(rel);
  if (SENSITIVE_NAMES.some((pattern) => pattern.test(name))) return true;

  const dot = name.lastIndexOf('.');
  const extension = dot <= 0 ? '' : name.slice(dot + 1);
  if (
    DATA_EXTENSIONS.has(extension) &&
    SENSITIVE_DATA_NAMES.some((pattern) => pattern.test(name))
  ) {
    return true;
  }

  return path
    .dirname(rel)
    .split(path.sep)
    .flatMap((segment) => segment.split('/'))
    .some((segment) => SENSITIVE_DIRS.has(segment));
}
// Content larger than this is dropped from events; occurrence is still kept.
const MAX_CONTENT_BYTES = 512 * 1024;

function targetFile(input) {
  return input.file_path || input.notebook_path;
}

function withinLimit(text) {
  return (
    typeof text === 'string' && Buffer.byteLength(text, 'utf8') <= MAX_CONTENT_BYTES
  );
}

function buildChange(toolName, input) {
  if (toolName === 'Edit') {
    return {
      kind: 'edit',
      oldText: withinLimit(input.old_string) ? input.old_string : '',
      newText: withinLimit(input.new_string) ? input.new_string : '',
    };
  }
  if (toolName === 'Write') {
    return {
      kind: 'write',
      content: withinLimit(input.content) ? input.content : '',
    };
  }
  // NotebookEdit and anything else: record the occurrence without content.
  return undefined;
}

// Baseline naming convention shared with the extension (see
// src/core/baselineStore.ts): workspace-relative path, forward slashes,
// percent-encoded into one flat file name.
function baselinePath(cwd, file) {
  const rel = path.relative(cwd, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return path.join(
    cwd,
    '.copyworkcode',
    'baselines',
    encodeURIComponent(rel.replace(/\\/g, '/'))
  );
}

function snapshotBaseline(cwd, file) {
  const dest = baselinePath(cwd, file);
  if (!dest) return;
  let content = '';
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    // File doesn't exist yet (about to be created): baseline is empty.
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.writeFileSync(dest, content, { flag: 'wx' });
  } catch {
    // Baseline already exists — never overwrite the last-reviewed state.
  }
}

function appendEvent(cwd, dataDir, payload, input, file) {
  const event = {
    id:
      payload.tool_use_id ||
      `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    source: 'agent-hook',
    agent: 'claude-code',
    file: path.resolve(cwd, file),
    toolName: payload.tool_name,
    change: isSensitive(cwd, file)
      ? undefined
      : buildChange(payload.tool_name, input),
    // Pointers, not contents: enough to find the message behind this change if
    // the review later asks what it was for. The transcript stays the agent's
    // own file, read on demand and never copied in here.
    intentRef: {
      transcriptPath: payload.transcript_path,
      sessionId: payload.session_id,
      toolUseId: payload.tool_use_id,
    },
  };
  fs.appendFileSync(
    path.join(dataDir, 'events.jsonl'),
    JSON.stringify(event) + '\n'
  );
}

function main(raw) {
  const payload = JSON.parse(raw);
  if (!FILE_TOOLS.has(payload.tool_name)) return;
  if (!payload.cwd) return;

  const dataDir = path.join(payload.cwd, '.copyworkcode');
  if (!fs.existsSync(dataDir)) return; // workspace not enabled

  const input = payload.tool_input || {};
  const file = targetFile(input);
  if (!file) return;
  const absolute = path.resolve(payload.cwd, file);

  if (payload.hook_event_name === 'PreToolUse') {
    // No baseline for a credentials file: the snapshot would be a verbatim copy
    // of it, and without a baseline the file has no review debt either.
    if (isSensitive(payload.cwd, absolute)) return;
    snapshotBaseline(payload.cwd, absolute);
  } else if (payload.hook_event_name === 'PostToolUse') {
    appendEvent(payload.cwd, dataDir, payload, input, absolute);
  }
}

let raw = '';
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', () => {
  try {
    main(raw);
  } catch {
    // Never surface errors into the agent session.
  }
  process.exit(0);
});
