/**
 * Matching engine for the guided retype: given the target text of one hunk,
 * decide what each keystroke does. Pure logic, no editor coupling — the
 * controller applies the returned insertions to the buffer.
 *
 * Rules (see design.md, "Retype matching rules"):
 * - Code is typed character-for-character; multi-character input (paste,
 *   completions) is rejected.
 * - Whitespace snaps to the target: any whitespace keystroke applies the
 *   target's pending whitespace, whatever it is. Typing the next visible
 *   character while whitespace is pending also applies it first, so
 *   indentation and line breaks can never cause a mismatch.
 * - One gesture crosses at most one line break. Whitespace snapping stops
 *   after the first newline and the indentation behind it, so a blank line
 *   costs a second keystroke — the same two the text would cost in an
 *   ordinary editor. Without the cap a single key could carry the reviewer
 *   over a paragraph break, which is a jump they didn't ask for in a flow
 *   whose whole point is that the change goes past them one piece at a time.
 * - Typographic punctuation takes any punctuation key. An em dash, a curly
 *   quote, an ellipsis or an arrow has no key on a standard keyboard, so any
 *   punctuation or symbol keystroke stands in for one. Letters and digits are
 *   never stood in for, in any script.
 */

export type InputResult =
  | { kind: 'insert'; text: string }
  | { kind: 'reject' };

export class RetypeEngine {
  /** Characters of the target already produced (typed or snapped). */
  private pos: number;

  /** `start` resumes a section that was paused partway through. */
  constructor(
    readonly target: string,
    start = 0
  ) {
    this.pos = Math.min(Math.max(start, 0), target.length);
  }

  get position(): number {
    return this.pos;
  }

  get done(): boolean {
    return this.pos >= this.target.length;
  }

  get remaining(): string {
    return this.target.slice(this.pos);
  }

  handleInput(typed: string): InputResult {
    if (this.done || typed.length === 0) {
      return { kind: 'reject' };
    }

    const snap = this.whitespaceRunAhead();

    if (/^\s+$/.test(typed)) {
      // Whitespace keystroke: only meaningful where the target has whitespace.
      if (snap.length === 0) {
        return { kind: 'reject' };
      }
      this.pos += snap.length;
      return { kind: 'insert', text: this.absorbTrailingWhitespace(snap) };
    }

    if ([...typed].length > 1) {
      return { kind: 'reject' };
    }

    const at = this.pos + snap.length;
    const expected = codePointAt(this.target, at);
    if (expected !== typed && !standsIn(typed, expected)) {
      return { kind: 'reject' };
    }
    // The target's own character is what is produced, whichever key stood in
    // for it, so a stand-in never changes the text.
    this.pos = at + expected.length;
    return { kind: 'insert', text: this.absorbTrailingWhitespace(snap + expected) };
  }

  /**
   * When only whitespace is left after an accepted keystroke, apply it too —
   * typing the last visible character completes the section instead of
   * leaving an invisible newline pending.
   */
  private absorbTrailingWhitespace(accepted: string): string {
    const rest = this.remaining;
    if (rest.length > 0 && /^\s+$/.test(rest)) {
      this.pos = this.target.length;
      return accepted + rest;
    }
    return accepted;
  }

  /**
   * The rest of the current target line, including its newline — the
   * fill-next-line control. Returns the text to insert and advances.
   */
  fillLine(): string {
    if (this.done) {
      return '';
    }
    const nl = this.target.indexOf('\n', this.pos);
    const end = nl === -1 ? this.target.length : nl + 1;
    const text = this.target.slice(this.pos, end);
    this.pos = end;
    return text;
  }

  /**
   * The pending whitespace plus the next word — the fill-next-word control.
   * A "word" is a run of identifier characters, or a run of adjacent symbols
   * when the next character isn't one (`=>` and `);` fill in one go), so the
   * gesture always lands on a boundary the reader recognizes.
   *
   * Moving to the next line is a word's worth of gesture on its own: when the
   * pending whitespace crosses a line break the fill stops there rather than
   * carrying on into the first word of the new line, which would land the
   * reviewer somewhere they hadn't looked yet.
   */
  fillWord(): string {
    if (this.done) {
      return '';
    }
    const snap = this.whitespaceRunAhead();
    if (/[\r\n]/.test(snap)) {
      this.pos += snap.length;
      return this.absorbTrailingWhitespace(snap);
    }
    const rest = this.target.slice(this.pos + snap.length);
    let end = 0;
    if (isWordChar(rest[end])) {
      while (end < rest.length && isWordChar(rest[end])) end++;
    } else {
      while (end < rest.length && isSymbol(rest[end])) end++;
    }
    this.pos += snap.length + end;
    return this.absorbTrailingWhitespace(snap + rest.slice(0, end));
  }

  /** Everything still untyped — used when a section is skipped. */
  fillRest(): string {
    const text = this.remaining;
    this.pos = this.target.length;
    return text;
  }

  /**
   * The whitespace one gesture may apply: everything up to the next line
   * break, that break, and the indentation of the line it opens — and then
   * nothing more, so a run spanning a blank line is handed over one line at a
   * time. A break is `\r?\n` so a CRLF target is never split down the middle.
   */
  private whitespaceRunAhead(): string {
    let end = this.spaceEnd(this.pos);
    const width = this.breakAt(end);
    if (width === 0) {
      return this.target.slice(this.pos, end);
    }
    return this.target.slice(this.pos, this.spaceEnd(end + width));
  }

  /** Past the whitespace at `from`, stopping at the first line break. */
  private spaceEnd(from: number): number {
    let end = from;
    while (
      end < this.target.length &&
      /\s/.test(this.target[end]) &&
      this.breakAt(end) === 0
    ) {
      end++;
    }
    return end;
  }

  /** Characters of the line break at `at`, or 0 if there isn't one. */
  private breakAt(at: number): number {
    if (this.target[at] === '\n') return 1;
    return this.target[at] === '\r' && this.target[at + 1] === '\n' ? 2 : 0;
  }
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}_$]/u.test(char);
}

function isSymbol(char: string | undefined): boolean {
  return char !== undefined && !/\s/.test(char) && !isWordChar(char);
}

/** The whole code point at `at`, or '' past the end. */
function codePointAt(text: string, at: number): string {
  const code = text.codePointAt(at);
  return code === undefined ? '' : String.fromCodePoint(code);
}

const PUNCTUATION = /^[\p{P}\p{S}]$/u;

/**
 * Whether a keystroke may stand in for a character it does not equal. Only
 * for punctuation and symbols outside ASCII — the em dash, the curly quote,
 * the ellipsis, the arrow — which a standard keyboard has no key for and an
 * assistant writes freely. Demanding the exact code point would turn a
 * review into a hunt for an input method, and would gain nothing: a matched
 * keystroke inserts nothing, so the file keeps the character it had either
 * way. Any punctuation or symbol key stands in, so the reviewer reads the
 * character and presses the nearest thing.
 */
function standsIn(typed: string, expected: string): boolean {
  const code = expected.codePointAt(0);
  return (
    code !== undefined &&
    code > 0x7f &&
    PUNCTUATION.test(expected) &&
    PUNCTUATION.test(typed)
  );
}
