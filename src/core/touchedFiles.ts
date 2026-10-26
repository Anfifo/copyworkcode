import * as fs from 'fs';
import * as path from 'path';
import { dataHome } from './dataHome';
import { IgnoreRule, isIgnored, lastMatch, parseIgnore, readIgnoreRules } from './ignoreFile';

/**
 * The files a shell command may have written, found after the fact: nothing
 * watches a command while it runs, so its writes are known only by what they
 * leave behind, and a modification time at or after the command started is
 * the one trace every write leaves. The caller decides what to make of each
 * file; this module only says which ones are worth a look.
 *
 * A walk of the whole workspace, one stat per file, is what that costs. It is
 * cheap in the workspaces this runs in because the folders that hold most of a
 * checkout's files (dependencies, build output, the repository's own store)
 * are pruned before they are entered. The rules that prune them are the ones
 * the workspace already keeps: its ignore files, read as patterns, so that no
 * repository tooling has to be present.
 *
 * Symbolic links are not followed, in either direction: a link to a folder
 * outside the workspace would otherwise walk it, and a linked file is somebody
 * else's.
 */

/** Never entered, whatever the ignore files say. */
const SKIPPED_DIRS = new Set(['.git', 'node_modules']);

const GIT_IGNORE = '.gitignore';

interface Level {
  base: string;
  rules: IgnoreRule[];
}

/** Workspace files whose modification time is at or after `sinceMs`. */
export function touchedSince(root: string, sinceMs: number): string[] {
  const found: string[] = [];
  const context = { root, sinceMs, workspaceRules: readIgnoreRules(root), home: dataHome() };
  walk(root, [], context, found);
  return found;
}

interface Walk {
  root: string;
  sinceMs: number;
  workspaceRules: IgnoreRule[];
  /** The data home is skipped should it sit inside the workspace. */
  home: string;
}

function walk(dir: string, levels: Level[], context: Walk, found: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const own = gitIgnoreRules(dir);
  if (own) levels = [...levels, { base: dir, rules: own }];

  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name) || file === context.home) continue;
      if (excluded(`${file}${path.sep}`, levels, context)) continue;
      walk(file, levels, context, found);
    } else if (entry.isFile()) {
      if (excluded(file, levels, context)) continue;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (stat.mtimeMs >= context.sinceMs) found.push(file);
    }
  }
}

/**
 * Whether the ignore files leave a path out. Each repository ignore file
 * speaks for the folder it sits in, relative to that folder, and a deeper one
 * overrides a shallower; the workspace's own ignore file has the last word.
 */
function excluded(file: string, levels: Level[], context: Walk): boolean {
  let ignored = false;
  for (const level of levels) {
    const verdict = lastMatch(relativeTo(level.base, file), level.rules);
    if (verdict !== undefined) ignored = verdict;
  }
  return ignored || isIgnored(relativeTo(context.root, file), context.workspaceRules);
}

/** Relative path, keeping the trailing separator that marks a folder. */
function relativeTo(base: string, file: string): string {
  const rel = path.relative(base, file);
  return file.endsWith(path.sep) ? `${rel}${path.sep}` : rel;
}

function gitIgnoreRules(dir: string): IgnoreRule[] | undefined {
  try {
    return parseIgnore(fs.readFileSync(path.join(dir, GIT_IGNORE), 'utf8'));
  } catch {
    return undefined;
  }
}
