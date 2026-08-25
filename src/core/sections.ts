/**
 * The review's unit of work: one changed region of a file, with its own
 * progress. Editor-independent so the offset arithmetic — the part that has to
 * survive arbitrary edits landing in the buffer mid-review — can be tested
 * without an editor.
 *
 * Sections are a *set*, not a sequence. Each one carries its own typing
 * position and its own outcome, and the review is done when every section is
 * claimed, in whatever order the reviewer got to them.
 *
 * Because the review happens in a real buffer, offsets cannot be assumed
 * stable: the reviewer's own editing, a formatter, an agent writing the file
 * again, an undo — all of them move text under the section set.
 * `remapSections` is the one place that reconciles them.
 */

import { diffLines } from './diff';

export type SectionKind = 'type' | 'confirm';

/**
 * How a section stopped needing attention.
 *
 * - `typed` — reproduced by hand, at least in part.
 * - `skipped` — filled in without typing it.
 * - `confirmed` — a deletion-only section, acknowledged.
 * - `edited` — the reviewer wrote their own text here, or the section was
 *   edited away entirely.
 */
export type SectionOutcome = 'typed' | 'skipped' | 'confirmed' | 'edited';

export interface Section {
  /** A `type` section is retyped; a `confirm` section marks lines that were
   * only deleted — nothing to retype, acknowledged with one action. */
  kind: SectionKind;
  /** Offset of the section's first character in the document. */
  start: number;
  /** Offset just past the section. For a `confirm` section this spans the line
   * the deletion happened at, so the cursor can be "in" it. */
  end: number;
  /** Document text of `[start, end)` — the retype target. '' for `confirm`. */
  target: string;
  /** The baseline lines that disappeared at this section, as text. Kept whole
   * rather than counted because a removal leaves nothing in the buffer to look
   * at: the text here is the only record of what went, and the surface shows it
   * on demand. Sticky across remapping, like `removedAtEnd` — later edits move
   * the section's offsets but cannot change what the baseline lost. */
  removedLines: string[];
  /** True when the removed lines were past the end of the file, so no line
   * follows them. The boundary a removal leaves behind is normally the line
   * that took its place; at the end of a file there is no such line, and the
   * only honest place to mark it is below the last one that survived. Sticky
   * across remapping: text appended afterwards moves the section's offsets but
   * does not change which end of the file the removal happened at. */
  removedAtEnd: boolean;
  /** Characters of `target` already claimed, from `start`. */
  position: number;
  /** True once any keystroke was matched here — what separates typed from
   * skipped when the section closes. */
  touched: boolean;
  /** True once the reviewer changed this section's text themselves, with
   * editing enabled. Only a record: the section still owes whatever it owes,
   * and the flag decides how it is reported when it closes. */
  handEdited: boolean;
  /** True once there is nothing left to match here: the section's text was
   * edited away entirely, so guidance has nothing to guide. */
  free: boolean;
  outcome?: SectionOutcome;
}

/** One replacement in a document: `[from, to)` becomes `text`. */
export interface TextChange {
  from: number;
  to: number;
  text: string;
}

/** The changed regions of `current` against `baseline`, as fresh sections. */
export function buildSections(baseline: string, current: string): Section[] {
  const starts = lineStarts(current);
  const offsetOfLine = (line: number) =>
    line < starts.length ? starts[line] : current.length;

  return diffLines(baseline, current).map((hunk) => {
    const start = offsetOfLine(hunk.currentStart);
    // Nothing follows a removal that ran off the end of the file. A hunk with
    // added lines always lands on a line that exists, so only a deletion can
    // be in this position.
    const removedAtEnd = hunk.currentStart >= starts.length;
    if (hunk.addedLines.length === 0) {
      return blank({
        kind: 'confirm',
        start,
        end: offsetOfLine(hunk.currentStart + 1),
        target: '',
        removedLines: hunk.removedLines,
        removedAtEnd,
      });
    }
    const end = offsetOfLine(hunk.currentStart + hunk.addedLines.length);
    return blank({
      kind: 'type',
      start,
      end,
      target: current.slice(start, end),
      removedLines: hunk.removedLines,
      removedAtEnd,
    });
  });
}

/**
 * Move the section set over a batch of document changes, **in place** — the
 * controller holds references to individual sections across awaits, so
 * remapping must not replace the objects.
 *
 * Each offset moves by where the change landed relative to it:
 * - wholly after the change → shifted by the change's delta;
 * - wholly before it → untouched;
 * - inside the replaced range → collapsed onto the replacement, so a section
 *   whose text an agent rewrote still covers the new text (and re-reviews it
 *   from the start), and a section deleted outright collapses to nothing.
 *
 * The typing position moves the same way, which is what makes the three cases
 * from the design fall out on their own: an edit before a section shifts it,
 * an edit inside text already typed rewinds the position to the edit, and an
 * edit in the untyped remainder just re-slices the target.
 *
 * `after` is the document text once every change has been applied; targets are
 * re-sliced from it so `target === after.slice(start, end)` always holds, and
 * the set stays disjoint and in offset order (`sections` is re-ordered in place
 * when a change moves one past another).
 */
export function remapSections(
  sections: Section[],
  changes: readonly TextChange[],
  after: string
): void {
  // Descending order means each change's own offsets are still valid when it
  // is applied: shifting text at a high offset cannot move a lower one.
  const ordered = [...changes].sort((a, b) => b.from - a.from);
  for (const change of ordered) {
    for (const section of sections) {
      shift(section, change);
    }
  }

  // A change that straddled two sections leaves both claiming the replacement
  // text. Sections have to stay disjoint — the cursor can only be in one of
  // them, and the same characters cannot be owed twice — so the later section
  // gives up the overlap to the earlier one.
  sections.sort((a, b) => a.start - b.start || a.end - b.end);
  let floor = 0;
  for (const section of sections) {
    const start = clamp(Math.max(section.start, floor), 0, after.length);
    const lost = start - section.start;
    section.start = start;
    section.end = clamp(section.end, start, after.length);
    section.position = Math.max(0, section.position - lost);
    floor = section.end;

    if (section.kind === 'confirm') {
      section.target = '';
      section.position = 0;
      continue;
    }
    section.target = after.slice(section.start, section.end);
    section.position = clamp(section.position, 0, section.target.length);
    // Nothing left to retype: the text this section stood for is gone, so the
    // reviewer's (or an agent's) edit is what closes it out.
    if (section.target.length === 0 && section.outcome === undefined) {
      section.outcome = 'edited';
      section.free = true;
    }
  }
}

function shift(section: Section, change: TextChange): void {
  const delta = change.text.length - (change.to - change.from);
  const start = section.start;
  const typed = start + section.position;
  // A section's start collapses onto the start of the replacement and its end
  // onto the end of it, so a rewritten region stays covered by the section
  // that used to own it.
  section.start = mapOffset(start, change, delta, change.from);
  section.end = mapOffset(
    section.end,
    change,
    delta,
    change.from + change.text.length
  );
  // Anything that reached into text the reviewer had already covered means the
  // claim only holds up to where the edit began — the characters after it are
  // not the ones that were read and reproduced any more.
  //
  // Otherwise the position rides along, and text inserted *at* it counts as
  // covered. That tie is what makes the reviewer's own writing behave: with
  // editing enabled they write at the typing position, and remapping alone
  // steps the position over what they added, so guidance does not turn around
  // and ask them to type their own text back. The cost is that a formatter
  // inserting at exactly the cursor is taken as covered too — the one offset
  // where that is a fair guess, since it is where the reviewer is typing.
  const claimed =
    change.to > start && change.from < typed
      ? Math.max(change.from, section.start)
      : typed >= change.from
        ? typed + delta
        : typed;
  section.position = Math.max(0, claimed - section.start);
}

function mapOffset(
  offset: number,
  change: TextChange,
  delta: number,
  inside: number
): number {
  // Order matters: an insertion (from === to) has no interior, so the first
  // branch is what decides its tie. The rule it produces: inserted text belongs
  // to whatever followed the insertion point — inserting at a section's start
  // extends the section, inserting at its end does not, and inserting at the
  // typing position leaves the new text on the untyped side of it.
  if (offset <= change.from) return offset;
  if (offset >= change.to) return offset + delta;
  return inside;
}

/** True once a section no longer wants the reviewer's attention. */
export function isClaimed(section: Section): boolean {
  return section.outcome !== undefined;
}

export function claimedCount(sections: readonly Section[]): number {
  return sections.filter(isClaimed).length;
}

export function outcomeCounts(
  sections: readonly Section[]
): Record<SectionOutcome, number> {
  const counts: Record<SectionOutcome, number> = {
    typed: 0,
    skipped: 0,
    confirmed: 0,
    edited: 0,
  };
  for (const section of sections) {
    if (section.outcome) counts[section.outcome]++;
  }
  return counts;
}

/** Where the next matched keystroke belongs, as a document offset. */
export function typedBoundary(section: Section): number {
  return section.start + section.position;
}

/**
 * The unclaimed section the cursor is in, if any — the one the review is
 * guiding right now. Half-open containment is tried first so a cursor sitting
 * exactly between two sections picks the one it is at the *start* of, where
 * typing can begin immediately; the second pass catches a section that ends at
 * the end of the document, which has no offset past it to sit at.
 */
export function sectionAt(
  sections: readonly Section[],
  offset: number
): Section | undefined {
  return (
    sections.find((s) => !isClaimed(s) && offset >= s.start && offset < s.end) ??
    sections.find((s) => !isClaimed(s) && offset === s.end)
  );
}

/** Any section covering this offset, claimed or not — for reporting where the
 * cursor is (e.g. inside a section the reviewer took over). */
export function enclosingSection(
  sections: readonly Section[],
  offset: number
): Section | undefined {
  return (
    sections.find((s) => offset >= s.start && offset < s.end) ??
    sections.find((s) => offset === s.end)
  );
}

/**
 * The section to lead the reviewer to next: the first unclaimed one at or
 * after `offset`, wrapping around to the first if there is none. Order is a
 * convenience for walking straight through, not a rule — nothing stops the
 * reviewer from clicking into any section at any time.
 */
export function nextUnclaimed(
  sections: readonly Section[],
  offset = 0
): Section | undefined {
  const open = sections
    .filter((s) => !isClaimed(s))
    .sort((a, b) => a.start - b.start);
  return open.find((s) => s.start >= offset) ?? open[0];
}

function blank(
  base: Pick<
    Section,
    'kind' | 'start' | 'end' | 'target' | 'removedLines' | 'removedAtEnd'
  >
): Section {
  return { ...base, position: 0, touched: false, handEdited: false, free: false };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/**
 * Offset of the first character of each line. A trailing newline does not open
 * a line, matching how the diff splits text, so the two agree on line numbers.
 */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n' && i + 1 < text.length) starts.push(i + 1);
  }
  return starts;
}
