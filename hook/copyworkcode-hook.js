#!/usr/bin/env node
'use strict';

// Claude Code hook installed for both PreToolUse and PostToolUse on the file
// tools and on the shell. Receives the tool event as JSON on stdin.
//
// File tools name the file they are about to change:
// - PreToolUse: snapshot the file's current content as its baseline if none
//   exists yet, preserving the pre-change state the review diff needs (the
//   file is about to change).
// - PostToolUse: append a change event to the workspace's event log.
//
// The shell names nothing, and a command can write anywhere through any
// program. Its writes are found afterwards: every workspace file whose
// modification time falls within the command's run is a candidate, and each
// one is checked against what the review would compare it to before it is
// recorded (see recordCommandWrites). The baseline for a file first seen this
// way comes from the repository when git can supply it, and is empty
// otherwise, so the file reviews as new in full.
//
// Three hard requirements shape this file:
// - It only records in workspaces that opted in (registered under the data
//   home), so it is safe to install at user scope for all projects.
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
const { registeredRootFor } = core('dataHome');
const { eventsPath } = core('paths');
const { baselineKey, readBaseline, seedBaseline } = core('baselineStore');
const { isSensitivePath } = core('sensitive');
const { hasDebt } = core('diff');
const { gitBaseline } = core('gitBaseline');
const { touchedSince } = core('touchedFiles');

const FILE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

// Content larger than this is dropped from events; occurrence is still kept.
const MAX_CONTENT_BYTES = 512 * 1024;

// A file above this size is not reviewable by typing, so a command writing
// one is not recorded. Same bound as the git comparison applies.
const MAX_REVIEWABLE_BYTES = 4 * 1024 * 1024;

// How far before a command started a write may be stamped and still be taken
// as the command's: filesystems round modification times, some to the second.
const START_SLACK_MS = 2000;

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

function appendEvent(root, payload, file, change, id) {
  const event = {
    id: id || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    source: 'agent-hook',
    agent: 'claude-code',
    file,
    toolName: payload.tool_name,
    change,
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

function recordFileTool(root, payload) {
  const input = payload.tool_input || {};
  const file = targetFile(input);
  if (!file) return;
  const absolute = path.resolve(payload.cwd, file);

  if (payload.hook_event_name === 'PreToolUse') {
    // No baseline for a credentials file: the snapshot would be a verbatim copy
    // of it, and without a baseline the file has no review debt either.
    if (isSensitive(root, absolute)) return;
    snapshotBaseline(root, absolute);
  } else if (payload.hook_event_name === 'PostToolUse') {
    const change = isSensitive(root, absolute)
      ? undefined
      : buildChange(payload.tool_name, input);
    appendEvent(root, payload, absolute, change, payload.tool_use_id);
  }
}

// One event per file the command changed, with no content: the command's
// text says nothing reliable about what it wrote, and the diff against the
// baseline is what gets reviewed anyway. Events carry the tool-use id plus the
// file, since one command can change many files.
function recordCommandWrites(root, payload) {
  const duration = Number(payload.duration_ms) || 0;
  const since = Date.now() - duration - START_SLACK_MS;
  for (const file of touchedSince(root, since)) {
    if (!changedContent(root, file)) continue;
    const id = payload.tool_use_id && `${payload.tool_use_id}:${baselineKey(root, file)}`;
    appendEvent(root, payload, file, undefined, id);
  }
}

// A fresh modification time is not proof of a change: copies, checkouts and
// formatters stamp files they leave as they were. So the content is held
// against the baseline when there is one, else against the repository's copy
// when git can produce it, which then becomes the baseline. Without git the
// time is all there is: the file is taken as new in full.
function changedContent(root, file) {
  // Never read: the occurrence alone is recorded, as for the file tools.
  if (isSensitive(root, file)) return true;
  const current = readReviewable(file);
  if (current === undefined) return false;
  const existing = readBaseline(root, file);
  if (existing !== undefined) return hasDebt(existing, current);
  const committed = gitBaseline(root, 'HEAD', file);
  if (committed !== undefined && !hasDebt(committed, current)) return false;
  seedBaseline(root, file, committed === undefined ? '' : committed);
  return true;
}

// Text within the reviewable size; undefined for anything else.
function readReviewable(file) {
  let content;
  try {
    if (fs.statSync(file).size > MAX_REVIEWABLE_BYTES) return undefined;
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  return content.includes('\0') ? undefined : content;
}

function main(raw) {
  const payload = JSON.parse(raw);
  const isShell = SHELL_TOOLS.has(payload.tool_name);
  if (!isShell && !FILE_TOOLS.has(payload.tool_name)) return;
  if (!payload.cwd) return;

  // The agent may have been started in a subfolder of the workspace the editor
  // has open; the nearest registered folder at or above it is the one.
  const root = registeredRootFor(payload.cwd);
  if (!root) return; // no enabled workspace here

  if (isShell) {
    // Nothing to do before a command runs: there is no file to snapshot.
    if (payload.hook_event_name === 'PostToolUse') recordCommandWrites(root, payload);
  } else {
    recordFileTool(root, payload);
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
