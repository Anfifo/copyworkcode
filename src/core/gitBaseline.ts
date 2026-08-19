import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Git as a baseline source: the side the review compares against is the
 * file's content at a revision (the working tree against HEAD by default)
 * instead of the last-reviewed snapshot. This covers what the snapshot store
 * cannot — changes that landed while nothing was tracking them, so there is
 * no snapshot to diff against.
 *
 * Strictly read-only: nothing here writes to the repository. Git runs as a
 * child process rather than through another extension's API, so the feature
 * has no dependency beyond git itself, and every call degrades to "nothing to
 * report" when git is missing or the folder is not a repository.
 */

/**
 * Untracked files above this size are not offered for review: they would be
 * read on every refresh, and nothing that large is reviewable by typing.
 */
const MAX_REVIEWABLE_BYTES = 4 * 1024 * 1024;

export interface GitChange {
  /** Absolute path of the changed file. */
  file: string;
  addedLines: number;
  removedLines: number;
  /** Absent from the revision entirely — the whole file is new. */
  untracked: boolean;
}

interface GitRun {
  /** The git executable was found and ran to completion. */
  ran: boolean;
  /** It ran and exited zero. */
  ok: boolean;
  stdout: string;
}

function git(root: string, args: string[]): GitRun {
  const run = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  const ran = !run.error && run.status !== null;
  return { ran, ok: ran && run.status === 0, stdout: run.stdout ?? '' };
}

/**
 * Every file that differs from `ref`, with its line counts. `undefined` means
 * the comparison itself is unavailable — no git, not a repository, or no such
 * revision (an empty repo has no HEAD) — as opposed to an empty array, which
 * means the working tree matches the revision.
 *
 * Binary files are left out: they have no reviewable text. Files git does not
 * track yet are included, minus anything the ignore rules exclude, so a file
 * an agent created from scratch shows up as one whole-file change.
 */
export function gitChanges(root: string, ref: string): GitChange[] | undefined {
  const diff = git(root, ['diff', '--numstat', '-z', ref, '--']);
  if (!diff.ok) return undefined;

  const changes = parseNumstat(root, diff.stdout);
  const others = git(root, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (others.ok) {
    for (const rel of others.stdout.split('\0')) {
      if (rel.length === 0) continue;
      const file = path.join(root, rel);
      const lines = countLines(file);
      if (lines === undefined) continue; // binary, unreadable, or too big
      changes.push({ file, addedLines: lines, removedLines: 0, untracked: true });
    }
  }
  return changes;
}

/**
 * The file's content at `ref` — the review's baseline in git mode. Empty
 * string when the path does not exist at that revision (a new file reviews as
 * one whole-file section); `undefined` only when git could not run at all, so
 * a missing git is never mistaken for "everything is new".
 */
export function gitBaseline(
  root: string,
  ref: string,
  file: string
): string | undefined {
  const rel = relativePosix(root, file);
  if (rel === undefined) return undefined; // outside the workspace
  const run = git(root, ['show', `${ref}:${rel}`]);
  if (!run.ran) return undefined;
  return run.ok ? run.stdout : '';
}

/**
 * `--numstat -z` emits `added\tremoved\tpath\0` per file, except for renames
 * and copies, which emit an empty path followed by the old and new paths as
 * two more records. Counts are `-` for binary files.
 */
function parseNumstat(root: string, stdout: string): GitChange[] {
  const fields = stdout.split('\0');
  const changes: GitChange[] = [];
  for (let i = 0; i < fields.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(fields[i]);
    if (!match) continue;
    let rel = match[3];
    if (rel.length === 0) {
      i += 2; // skip the old path; the new one is the file as it exists now
      rel = fields[i] ?? '';
    }
    if (rel.length === 0 || match[1] === '-' || match[2] === '-') continue;
    changes.push({
      file: path.join(root, rel),
      addedLines: Number(match[1]),
      removedLines: Number(match[2]),
      untracked: false,
    });
  }
  return changes;
}

function relativePosix(root: string, file: string): string | undefined {
  const rel = path.relative(root, file);
  if (rel.length === 0 || rel.startsWith('..') || path.isAbsolute(rel)) {
    return undefined;
  }
  return rel.replace(/\\/g, '/');
}

/** Line count of a reviewable text file; `undefined` when it isn't one. */
function countLines(file: string): number | undefined {
  let content: string;
  try {
    if (fs.statSync(file).size > MAX_REVIEWABLE_BYTES) return undefined;
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  if (content.includes('\0')) return undefined; // binary
  if (content.length === 0) return 0;
  return content.replace(/\n$/, '').split('\n').length;
}
