/**
 * The whole change set as one readable document: every file with debt, every
 * changed region in it, and the surviving code around each region.
 *
 * Editor-independent and serializable, because the surface that renders this is
 * a page rather than a buffer — the offsets a review works in and the line
 * numbers a reader reads by are different things, and this is where the first
 * becomes the second. Regions come from `buildSections` unchanged, so a region
 * means the same thing here as in an editor review and the two surfaces can
 * point at each other by index.
 *
 * Context is bounded and expandable rather than whole-file. A change set can
 * span thousands of lines nobody intends to read, and sending every one of them
 * to open the page is a cost paid on every file for the sake of the few gaps
 * anyone opens. `sliceLines` answers those on demand.
 *
 * The document is line-ending normalized, unlike the review a buffer runs. A
 * buffer holds the file's own endings and a matched keystroke has to leave them
 * alone; a page holds text nodes, where a carriage return is a line break in its
 * own right and would draw a phantom blank line under every row of a CRLF file.
 * Nothing is lost by dropping them: endings are already normalized before the
 * diff, so a bare CR is never part of a change and never something the reviewer
 * owes.
 *
 * Lines are counted the way an editor counts them, not the way the diff does: a
 * trailing newline opens an empty last line here. That is a deliberate break
 * from `countLines`, and the removal geometry is why. A removal that ran off the
 * end of the file is anchored on exactly that empty line — it is where the
 * deleted text was — so a count that leaves the line out has nowhere to put the
 * section and drops it. The cost is that the last gap in a file ending the usual
 * way holds one line with nothing on it.
 */

import { normalizeEol } from './diff';
import { Section, buildSections } from './sections';

/** One line of surviving code, numbered the way an editor numbers it. */
export interface ViewLine {
  /** 1-based line number in the current file. */
  n: number;
  text: string;
}

/** A changed region, as the page draws it. */
export interface ViewSection {
  /** Index in the file's section set — the handle both surfaces share. */
  index: number;
  /** `type` owes keystrokes; `confirm` only lost lines and is acknowledged. */
  kind: Section['kind'];
  /** 1-based first line of the added run, or the line a removal is marked at. */
  line: number;
  /** The text a retype has to produce. Empty for `confirm`. */
  target: string;
  /** `target` split for rendering, with its trailing newline dropped. */
  addedLines: ViewLine[];
  /** What the baseline lost here — shown in place, never typed. */
  removedLines: string[];
  /** The removal ran off the end of the file, so no line follows it. */
  removedAtEnd: boolean;
}

/**
 * The document is a flat run of blocks in file order. A `gap` stands for lines
 * deliberately left out; it carries the range so the page can ask for them.
 */
export type ViewBlock =
  | { kind: 'context'; lines: ViewLine[] }
  | { kind: 'gap'; from: number; to: number }
  | { kind: 'section'; section: ViewSection };

export interface FileView {
  /** Absolute path — what commands take. */
  file: string;
  /** Workspace-relative path — what the reader reads. */
  relative: string;
  addedLines: number;
  removedLines: number;
  /** Nothing to compare against: the file is new since the baseline. */
  isNew: boolean;
  /** Lines in the current file, so a gap can say how much it is holding. */
  totalLines: number;
  blocks: ViewBlock[];
}

/** Lines of surviving code kept either side of a changed region. */
const DEFAULT_CONTEXT = 3;

/**
 * Build one file's document. `baseline` is what the review compares against,
 * `current` the file as it stands.
 */
export function buildFileView(
  file: string,
  relative: string,
  baseline: string,
  current: string,
  context = DEFAULT_CONTEXT
): FileView {
  const text = normalizeEol(current);
  const lines = text.split('\n');
  const starts = lineStarts(text);
  const sections = buildSections(baseline, text).map((section, index) =>
    toView(section, index, starts)
  );

  return {
    file,
    relative,
    addedLines: sections.reduce((n, s) => n + s.addedLines.length, 0),
    removedLines: sections.reduce((n, s) => n + s.removedLines.length, 0),
    isNew: baseline.length === 0,
    totalLines: lines.length,
    blocks: layout(sections, lines, context),
  };
}

function toView(section: Section, index: number, starts: readonly number[]): ViewSection {
  const first = lineIndexAt(starts, section.start);
  const body = section.target.endsWith('\n')
    ? section.target.slice(0, -1)
    : section.target;
  return {
    index,
    kind: section.kind,
    line: first + 1,
    target: section.target,
    addedLines:
      section.kind === 'type'
        ? body.split('\n').map((text, i) => ({ n: first + i + 1, text }))
        : [],
    removedLines: section.removedLines,
    removedAtEnd: section.removedAtEnd,
  };
}

/**
 * Lay the regions out with their context as a run of blocks covering the file
 * top to bottom. Three rules, each one a thing the reader would otherwise have
 * to work around:
 *
 * - **Context surrounds a region on both sides.** Between two regions the same
 *   lines serve as the first one's tail and the second one's head, so the ranges
 *   are merged before anything is emitted rather than per region.
 * - **A gap only exists when it saves something.** A control that hides three
 *   lines and reveals the same three lines is worse than the lines, so a short
 *   hole between two regions of interest is simply shown.
 * - **Context never overlaps a region.** A region's lines belong to the region.
 *   That matters most for a deletion, which is anchored at a line it did not
 *   change: printing that line as quiet background too would draw it twice.
 */
function layout(
  sections: readonly ViewSection[],
  lines: readonly string[],
  context: number
): ViewBlock[] {
  if (sections.length === 0) return [];

  const total = lines.length;
  const blocks: ViewBlock[] = [];
  const line = (n: number): ViewLine => ({ n, text: lines[n - 1] ?? '' });

  // Regions of interest: each section's own lines plus its context, merged
  // wherever the hole between two of them is too small to be worth a control.
  const spans: Array<{ from: number; to: number }> = [];
  for (const section of sections) {
    const reach = extent(section);
    const from = Math.max(1, reach.from - context);
    const to = Math.min(total, reach.to + context);
    const last = spans[spans.length - 1];
    if (last && from - last.to - 1 <= context) {
      last.to = Math.max(last.to, to);
    } else {
      spans.push({ from, to });
    }
  }

  let next = 0;
  let covered = 0;
  for (const span of spans) {
    if (span.from > covered + 1) {
      blocks.push({ kind: 'gap', from: covered + 1, to: span.from - 1 });
    }
    let n = span.from;
    let run: ViewLine[] = [];
    while (n <= span.to) {
      const section = sections[next];
      const reach = section ? extent(section) : undefined;
      if (reach && n >= reach.from) {
        if (run.length > 0) {
          blocks.push({ kind: 'context', lines: run });
          run = [];
        }
        blocks.push({ kind: 'section', section });
        next++;
        n = Math.max(n, reach.to + 1);
        continue;
      }
      run.push(line(n));
      n++;
    }
    if (run.length > 0) {
      blocks.push({ kind: 'context', lines: run });
    }
    covered = Math.max(covered, span.to);
  }
  if (total > covered) {
    blocks.push({ kind: 'gap', from: covered + 1, to: total });
  }
  return blocks;
}

/** The 1-based lines a region occupies, inclusive. */
function extent(section: ViewSection): { from: number; to: number } {
  const height = section.kind === 'confirm' ? 1 : Math.max(section.addedLines.length, 1);
  return { from: section.line, to: section.line + height - 1 };
}

/** Lines `[from, to]`, 1-based and inclusive — what a gap's control asks for. */
export function sliceLines(current: string, from: number, to: number): ViewLine[] {
  const lines = normalizeEol(current).split('\n');
  const out: ViewLine[] = [];
  for (let n = Math.max(1, from); n <= Math.min(to, lines.length); n++) {
    out.push({ n, text: lines[n - 1] });
  }
  return out;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

/** Index of the line containing `offset`, by binary search over line starts. */
function lineIndexAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}
