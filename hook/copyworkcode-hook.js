#!/usr/bin/env node
'use strict';

// PostToolUse hook installed into Claude Code. Receives the tool event as JSON
// on stdin and appends a change event to <cwd>/.copyworkcode/events.jsonl.
//
// Two hard requirements shape this file:
// - It only records in workspaces that opted in (the data directory exists),
//   so it is safe to install at user scope for all projects.
// - It must never disturb the agent session: any failure exits 0 silently.
//   Plain Node, no dependencies, so it runs wherever the agent runs.

const fs = require('fs');
const path = require('path');

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// Full-file snapshots above this size are dropped; the diff text is still kept.
const MAX_SNAPSHOT_BYTES = 512 * 1024;

function buildChange(toolName, input) {
  if (toolName === 'Edit' || toolName === 'MultiEdit') {
    const change = {
      kind: 'edit',
      oldText: input.old_str ?? input.old_string ?? '',
      newText: input.new_str ?? input.new_string ?? '',
    };
    const base = input.file_text;
    if (typeof base === 'string' && Buffer.byteLength(base, 'utf8') <= MAX_SNAPSHOT_BYTES) {
      change.baseContent = base;
    }
    return change;
  }
  if (toolName === 'Write') {
    const content = input.file_text ?? input.content;
    if (typeof content !== 'string') return undefined;
    return {
      kind: 'write',
      content:
        Buffer.byteLength(content, 'utf8') <= MAX_SNAPSHOT_BYTES ? content : '',
    };
  }
  // NotebookEdit and anything else: record the occurrence without content.
  return undefined;
}

function main(raw) {
  const payload = JSON.parse(raw);
  if (!FILE_TOOLS.has(payload.tool_name)) return;
  if (!payload.cwd) return;

  const dataDir = path.join(payload.cwd, '.copyworkcode');
  if (!fs.existsSync(dataDir)) return; // workspace not enabled

  const input = payload.tool_input || {};
  if (!input.file_path) return;

  const event = {
    id:
      payload.tool_use_id ||
      `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    source: 'agent-hook',
    agent: 'claude-code',
    file: input.file_path,
    toolName: payload.tool_name,
    change: buildChange(payload.tool_name, input),
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
