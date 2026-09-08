import * as fs from 'fs';
import * as path from 'path';
import { matchesAny } from './glob';

/**
 * Files the reviewer never wants queued, listed in a file at the workspace
 * root the way a formatter's ignore file is. It belongs to the project and is
 * written only when the reviewer ignores something, so a workspace that never
 * does never gets one.
 *
 * One pattern per line, `#` starts a comment, a leading `!` puts matching
 * files back. Patterns follow the shape of a gitignore line closely enough for
 * the common cases: a pattern without a slash matches a name at any depth, a
 * leading slash anchors it to the root, a trailing slash means a folder and
 * everything in it. Matching is the glob matcher the auto-skip setting uses,
 * and the last matching line wins.
 */
export const IGNORE_FILE = '.copyworkcodeignore';

export interface IgnoreRule {
  glob: string;
  negated: boolean;
}

export function ignoreFilePath(root: string): string {
  return path.join(root, IGNORE_FILE);
}

export function parseIgnore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const negated = line.startsWith('!');
    const pattern = negated ? line.slice(1).trim() : line;
    if (pattern.length === 0) continue;
    rules.push({ glob: toGlob(pattern), negated });
  }
  return rules;
}

/** The rules in the workspace's ignore file; none when there is no file. */
export function readIgnoreRules(root: string): IgnoreRule[] {
  try {
    return parseIgnore(fs.readFileSync(ignoreFilePath(root), 'utf8'));
  } catch {
    return [];
  }
}

/** Whether `relativePath`, workspace-relative, is kept out of the queue. */
export function isIgnored(relativePath: string, rules: IgnoreRule[]): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  let ignored = false;
  for (const rule of rules) {
    if (matchesAny(normalized, [rule.glob])) ignored = !rule.negated;
  }
  return ignored;
}

/**
 * Add a line to the ignore file, creating it when this is the first. The line
 * is written as given, so what the reviewer chose is what they read back.
 */
export function appendIgnore(root: string, pattern: string): void {
  const file = ignoreFilePath(root);
  let existing = '';
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch {
    // No file yet: this line starts it.
  }
  const separator = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  fs.writeFileSync(file, `${existing}${separator}${pattern}\n`);
}

/**
 * The lines the right-click offers for a file: the file itself, its folder,
 * and its extension anywhere. The folder and the extension are omitted where
 * they would be the root and where the name has none.
 */
export function suggestPatterns(relativePath: string): string[] {
  const rel = relativePath.replace(/\\/g, '/');
  const patterns = [`/${rel}`];
  const dir = path.posix.dirname(rel);
  if (dir !== '.') patterns.push(`/${dir}/`);
  const ext = path.posix.extname(rel);
  if (ext.length > 1) patterns.push(`*${ext}`);
  return patterns;
}

function toGlob(pattern: string): string {
  let glob = pattern.replace(/\\/g, '/');
  const anchored = glob.startsWith('/');
  if (anchored) glob = glob.slice(1);
  if (glob.endsWith('/')) glob += '**';
  if (!anchored && !glob.includes('/')) glob = `**/${glob}`;
  return glob;
}
