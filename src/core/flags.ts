import { Section, isClaimed } from './sections';

/**
 * Sections the agent asked the reviewer to type. The agent calls the flag tool
 * (mcp/copyworkcode-mcp.js) after an edit with an excerpt of what it wrote and
 * why that part deserves attention; each call becomes one line in the
 * workspace's `flags.jsonl`. The server requires this module's compiled output
 * to check an excerpt, and the review uses it to find the excerpt again, so the
 * two agree on what "the same text" means.
 *
 * A flag only ever adds to a review. It marks a section and moves it up the
 * walk; nothing here can make a section optional, because the author of a
 * change choosing what its reviewer reads is the over-trust the review exists
 * to counter.
 *
 * An excerpt is anchored by its text. Offsets go stale the moment the file is
 * edited again, so each flag keeps the offset it was found at only to choose
 * between repeats, and is placed afresh against whatever the file holds now.
 * A flag whose excerpt is gone no longer points at anything and is dropped.
 */

export type Importance = 'must-type' | 'worth-typing';

export const IMPORTANCE: readonly Importance[] = ['must-type', 'worth-typing'];

export interface Flag {
  id: string;
  /** ISO time the flag was made. */
  timestamp: string;
  /** Absolute path, as the agent named it. */
  file: string;
  excerpt: string;
  /** Where the excerpt was when the flag was made. */
  offset: number;
  importance: Importance;
  reason: string;
  intent?: string;
}

/** A flag found in the current text of its file. */
export interface PlacedFlag {
  start: number;
  end: number;
  importance: Importance;
  reason: string;
  intent?: string;
  timestamp: string;
}

/** Every line that parses as a flag, oldest first. Anything else is skipped. */
export function parseFlags(raw: string): Flag[] {
  const flags: Flag[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (isFlag(value)) flags.push(value);
  }
  return flags;
}

/**
 * Where `excerpt` occurs in `content`. The agent quotes with plain newlines
 * while the file may use CRLF, so the excerpt is matched in the file's own
 * line endings.
 */
export function occurrences(
  content: string,
  excerpt: string
): { at: number; length: number }[] {
  const needle =
    content.includes('\r\n') && !excerpt.includes('\r\n')
      ? excerpt.replace(/\n/g, '\r\n')
      : excerpt;
  const found: { at: number; length: number }[] = [];
  if (!needle) return found;
  for (let at = content.indexOf(needle); at !== -1; at = content.indexOf(needle, at + 1)) {
    found.push({ at, length: needle.length });
  }
  return found;
}

/** Each flag at the occurrence of its excerpt nearest where it was made. */
export function placeFlags(content: string, flags: readonly Flag[]): PlacedFlag[] {
  const placed: PlacedFlag[] = [];
  for (const flag of flags) {
    const hits = occurrences(content, flag.excerpt);
    if (hits.length === 0) continue;
    const hit = hits.reduce((best, h) =>
      Math.abs(h.at - flag.offset) < Math.abs(best.at - flag.offset) ? h : best
    );
    placed.push({
      start: hit.at,
      end: hit.at + hit.length,
      importance: flag.importance,
      reason: flag.reason,
      intent: flag.intent,
      timestamp: flag.timestamp,
    });
  }
  return placed;
}

/**
 * The flag a section carries: one that overlaps it, must-type over
 * worth-typing, and the newest of those. A deletion has no text of its own, so
 * it carries a flag that touches the line it sits on.
 */
export function flagFor(
  section: Pick<Section, 'start' | 'end'>,
  placed: readonly PlacedFlag[]
): PlacedFlag | undefined {
  let best: PlacedFlag | undefined;
  for (const flag of placed) {
    const overlaps = flag.start < section.end && section.start < flag.end;
    const touches =
      section.start === section.end &&
      flag.start <= section.start &&
      section.start <= flag.end;
    if (!overlaps && !touches) continue;
    if (!best || outranks(flag, best)) best = flag;
  }
  return best;
}

/**
 * The section the walk should lead to next: the next unclaimed must-type
 * section after `offset`, else the next worth-typing one, wrapping around in
 * each case. Undefined when no unclaimed section carries a flag, so the caller
 * falls back to its own order.
 */
export function nextFlagged(
  sections: readonly Section[],
  placed: readonly PlacedFlag[],
  offset = 0
): Section | undefined {
  for (const importance of IMPORTANCE) {
    const open = sections
      .filter((s) => !isClaimed(s) && flagFor(s, placed)?.importance === importance)
      .sort((a, b) => a.start - b.start);
    const next = open.find((s) => s.start >= offset) ?? open[0];
    if (next) return next;
  }
  return undefined;
}

function outranks(flag: PlacedFlag, other: PlacedFlag): boolean {
  const a = IMPORTANCE.indexOf(flag.importance);
  const b = IMPORTANCE.indexOf(other.importance);
  return a < b || (a === b && flag.timestamp > other.timestamp);
}

function isFlag(value: unknown): value is Flag {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'string' &&
    typeof v.timestamp === 'string' &&
    typeof v.file === 'string' &&
    typeof v.excerpt === 'string' &&
    v.excerpt.length > 0 &&
    typeof v.offset === 'number' &&
    IMPORTANCE.includes(v.importance as Importance) &&
    typeof v.reason === 'string' &&
    (v.intent === undefined || typeof v.intent === 'string')
  );
}
