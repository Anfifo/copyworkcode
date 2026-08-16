/**
 * Minimal glob matching for auto-skip rules. Supports `**` (any path
 * segments), `*` (within a segment), and `?` (single character). Paths are
 * normalized to forward slashes before matching.
 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  const g = glob.replace(/\\/g, '/');
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') {
          re += '(?:[^/]*/)*';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(filePath: string, globs: string[]): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return globs.some((g) => globToRegExp(g).test(normalized));
}
