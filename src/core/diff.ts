/**
 * Line-based diff between a baseline snapshot and the current file content.
 * Output is the list of changed regions ("hunks") in the current file — the
 * units the guided retype walks through.
 *
 * Line endings are normalized before diffing so CRLF/LF differences never
 * count as review debt.
 */

export interface DiffHunk {
  /** First line of the added run in the current text (0-based). */
  currentStart: number;
  /** Lines present in current but not in baseline — the retype target. */
  addedLines: string[];
  /** First line of the removed run in the baseline text (0-based). */
  baseStart: number;
  /** Lines present in baseline but gone from current — shown, never typed. */
  removedLines: string[];
}

export function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/** True when the two texts differ by more than line endings. */
export function hasDebt(baseline: string, current: string): boolean {
  return normalizeEol(baseline) !== normalizeEol(current);
}

// Above this many lines on both sides (after trimming the common prefix and
// suffix), the quadratic LCS table gets too big; collapse to one big hunk.
const MAX_LCS_LINES = 3000;

export function diffLines(baseline: string, current: string): DiffHunk[] {
  const a = splitLines(normalizeEol(baseline));
  const b = splitLines(normalizeEol(current));

  // Trim common prefix/suffix — the interesting region is usually small.
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }

  const aMid = a.slice(prefix, a.length - suffix);
  const bMid = b.slice(prefix, b.length - suffix);
  if (aMid.length === 0 && bMid.length === 0) {
    return [];
  }

  if (aMid.length > MAX_LCS_LINES && bMid.length > MAX_LCS_LINES) {
    return [
      {
        currentStart: prefix,
        addedLines: bMid,
        baseStart: prefix,
        removedLines: aMid,
      },
    ];
  }

  // Classic LCS backtrack over the trimmed middle.
  const n = aMid.length;
  const m = bMid.length;
  const table = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[at(i, j)] =
        aMid[i] === bMid[j]
          ? table[at(i + 1, j + 1)] + 1
          : Math.max(table[at(i + 1, j)], table[at(i, j + 1)]);
    }
  }

  const hunks: DiffHunk[] = [];
  let i = 0;
  let j = 0;
  let open: DiffHunk | undefined;
  const close = () => {
    if (open) {
      hunks.push(open);
      open = undefined;
    }
  };
  const ensureOpen = (): DiffHunk => {
    if (!open) {
      open = {
        currentStart: prefix + j,
        addedLines: [],
        baseStart: prefix + i,
        removedLines: [],
      };
    }
    return open;
  };
  while (i < n || j < m) {
    if (i < n && j < m && aMid[i] === bMid[j]) {
      close();
      i++;
      j++;
    } else if (j < m && (i >= n || table[at(i, j + 1)] >= table[at(i + 1, j)])) {
      ensureOpen().addedLines.push(bMid[j]);
      j++;
    } else {
      ensureOpen().removedLines.push(aMid[i]);
      i++;
    }
  }
  close();
  return hunks;
}

function splitLines(text: string): string[] {
  const lines = text.split('\n');
  // A trailing newline produces a final empty element that is not a line.
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}
