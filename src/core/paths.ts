import * as path from 'path';
import { workspaceDir } from './dataHome';

/**
 * Layout of a workspace's runtime data folder, which lives under the data
 * home (see dataHome.ts), never inside the workspace. The capture hook
 * requires this module's compiled output, so the extension and the hook read
 * every name here from one place.
 */
export const EVENTS_FILE = 'events.jsonl';
const STATE_FILE = 'state.json';
const BASELINES_DIR = 'baselines';

export function dataDir(root: string): string {
  return workspaceDir(root);
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
