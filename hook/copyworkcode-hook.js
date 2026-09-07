#!/usr/bin/env node
'use strict';

// Claude Code hook installed for both PreToolUse and PostToolUse on file
// tools. Receives the tool event as JSON on stdin.
//
// - PreToolUse: snapshot the file's current content as its baseline if none
//   exists yet, preserving the pre-change state the review diff needs (the
//   file is about to change).
// - PostToolUse: append a change event to the workspace's event log.
//
// Three hard requirements shape this file:
// - It only records in workspaces that opted in (the data directory exists),
//   so it is safe to install at user scope for all projects.
// - It never copies the content of a credentials file, in either direction:
//   no baseline snapshot and no text in the event. The occurrence is still
//   recorded, so an agent touching one is visible, but the secret is not
//   duplicated anywhere.
// - It must never disturb the agent session: any failure exits 0 silently.
//
// Plain Node with no package dependencies, so it runs wherever the agent runs.
// The rules it shares with the extension — where the data lives, how baselines
// are named, which files are sensitive — come from the extension's compiled
// core modules, which sit next to this script in the installed extension.
// One implementation, read by both sides.

const fs = require('fs');
const path = require('path');

const core = (name) => require(path.join(__dirname, '..', 'out', 'core', name));
const { dataDir, eventsPath } = core('paths');
const { seedBaseline } = core('baselineStore');
const { isSensitivePath } = core('sensitive');

const FILE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

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

function isSensitive(root, file) {
  return isSensitivePath(path.relative(root, file));
}

function snapshotBaseline(root, file) {
  let content = '';
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    // File doesn't exist yet (about to be created): baseline is empty.
  }
  seedBaseline(root, file, content);
}

function appendEvent(root, payload, input, file) {
  const event = {
    id:
      payload.tool_use_id ||
      `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    source: 'agent-hook',
    agent: 'claude-code',
    file,
    toolName: payload.tool_name,
    change: isSensitive(root, file) ? undefined : buildChange(payload.tool_name, input),
    // Pointers, not contents: enough to find the message behind this change if
    // the review later asks what it was for. The transcript stays the agent's
    // own file, read on demand and never copied in here.
    intentRef: {
      transcriptPath: payload.transcript_path,
      sessionId: payload.session_id,
      toolUseId: payload.tool_use_id,
    },
  };
  fs.appendFileSync(eventsPath(root), JSON.stringify(event) + '\n');
}

function main(raw) {
  const payload = JSON.parse(raw);
  if (!FILE_TOOLS.has(payload.tool_name)) return;
  if (!payload.cwd) return;

  const root = payload.cwd;
  if (!fs.existsSync(dataDir(root))) return; // workspace not enabled

  const input = payload.tool_input || {};
  const file = targetFile(input);
  if (!file) return;
  const absolute = path.resolve(root, file);

  if (payload.hook_event_name === 'PreToolUse') {
    // No baseline for a credentials file: the snapshot would be a verbatim copy
    // of it, and without a baseline the file has no review debt either.
    if (isSensitive(root, absolute)) return;
    snapshotBaseline(root, absolute);
  } else if (payload.hook_event_name === 'PostToolUse') {
    appendEvent(root, payload, input, absolute);
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
