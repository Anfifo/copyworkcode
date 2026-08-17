import * as fs from 'fs';
import * as path from 'path';
import { baselinesDir } from './paths';
import { hasDebt } from './diff';

/**
 * Per-file snapshots of the last-reviewed content, stored as one file per
 * source file under `.copyworkcode/baselines/`. Review debt for a file is the
 * diff between its baseline and its current content; completing (or skipping)
 * a review advances the baseline.
 *
 * The initial snapshot for a file is written by the capture hook *before* the
 * agent's first edit (PreToolUse), so the pre-change content is preserved even
 * when the editor is closed. The hook re-implements the naming convention
 * below in plain JS — keep the two in sync.
 *
 * Naming: workspace-relative path, forward slashes, percent-encoded into a
 * single flat file name. A file without a baseline has no review debt.
 */

export function baselineKey(root: string, file: string): string | undefined {
  const rel = path.relative(root, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return undefined; // outside the workspace — not ours to track
  }
  return encodeURIComponent(rel.replace(/\\/g, '/'));
}

export function baselinePath(root: string, file: string): string | undefined {
  const key = baselineKey(root, file);
  return key === undefined ? undefined : path.join(baselinesDir(root), key);
}

export function readBaseline(root: string, file: string): string | undefined {
  const p = baselinePath(root, file);
  if (!p) return undefined;
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
}

/** Set the baseline to the given content (review completed or skipped). */
export function advanceBaseline(
  root: string,
  file: string,
  content: string
): void {
  const p = baselinePath(root, file);
  if (!p) return;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

/** All workspace files that currently have a baseline snapshot. */
export function trackedFiles(root: string): string[] {
  let keys: string[];
  try {
    keys = fs.readdirSync(baselinesDir(root));
  } catch {
    return [];
  }
  return keys.map((k) =>
    path.join(root, decodeURIComponent(k).replace(/\//g, path.sep))
  );
}

export interface FileDebt {
  file: string;
  baseline: string;
  current: string;
}

/** Files whose current content differs from their last-reviewed baseline. */
export function filesWithDebt(root: string): FileDebt[] {
  const result: FileDebt[] = [];
  for (const file of trackedFiles(root)) {
    const baseline = readBaseline(root, file);
    if (baseline === undefined) continue;
    let current: string;
    try {
      current = fs.readFileSync(file, 'utf8');
    } catch {
      current = ''; // file deleted — reviewing acknowledges the deletion
    }
    if (hasDebt(baseline, current)) {
      result.push({ file, baseline, current });
    }
  }
  return result;
}
