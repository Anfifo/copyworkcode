import * as fs from 'fs';
import * as path from 'path';

/**
 * Hide a path from git using `.git/info/exclude` — the repo-local ignore list
 * that is never committed and never shows as a change. The alternative would be
 * the project's own `.gitignore`, which is shared with everyone working on the
 * repository: one person enabling a review tool has no business editing a
 * tracked file for the whole team. This is the narrower option — a single line
 * in a file git treats as local configuration, which goes inert the moment the
 * data directory is gone.
 *
 * No-op when the folder isn't a git repository. Handles `.git` being a file
 * (worktrees, submodules) by following its `gitdir:` pointer.
 */
export function ensureLocalGitExclude(root: string, entry: string): void {
  const gitDir = resolveGitDir(root);
  if (!gitDir) return;

  const excludePath = path.join(gitDir, 'info', 'exclude');
  let current = '';
  try {
    current = fs.readFileSync(excludePath, 'utf8');
  } catch {
    // No exclude file yet.
  }
  if (current.split(/\r?\n/).includes(entry)) return;

  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  const suffix = current.length === 0 || current.endsWith('\n') ? '' : '\n';
  fs.appendFileSync(excludePath, `${suffix}${entry}\n`);
}

function resolveGitDir(root: string): string | undefined {
  const dotGit = path.join(root, '.git');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dotGit);
  } catch {
    return undefined; // not a git repository
  }
  if (stat.isDirectory()) {
    return dotGit;
  }
  // Worktree or submodule: `.git` is a file pointing at the real git dir.
  try {
    const match = /^gitdir:\s*(.+)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'));
    if (match) {
      return path.resolve(root, match[1].trim());
    }
  } catch {
    // Unreadable pointer file — treat as not a repo.
  }
  return undefined;
}
