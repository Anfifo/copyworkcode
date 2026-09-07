import * as path from 'path';

/**
 * Layout of the per-workspace runtime data directory. Shared between the
 * extension and (by convention, re-implemented in plain JS) the capture hook —
 * the two must agree on every name here.
 */
export const DATA_DIR = '.copyworkcode';
export const EVENTS_FILE = 'events.jsonl';
const STATE_FILE = 'state.json';
const BASELINES_DIR = 'baselines';

export function dataDir(root: string): string {
  return path.join(root, DATA_DIR);
}

export function eventsPath(root: string): string {
  return path.join(dataDir(root), EVENTS_FILE);
}

export function statePath(root: string): string {
  return path.join(dataDir(root), STATE_FILE);
}

export function baselinesDir(root: string): string {
  return path.join(dataDir(root), BASELINES_DIR);
}
