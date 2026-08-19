/**
 * Matching engine for the guided retype: given the target text of one hunk,
 * decide what each keystroke does. Pure logic, no editor coupling — the
 * controller applies the returned insertions to the buffer.
 *
 * Rules (see design.md, "Retype matching rules"):
 * - Code is typed character-for-character; multi-character input (paste,
 *   completions) is rejected.
 * - Whitespace snaps to the target: any whitespace keystroke applies the
 *   target's whitespace run, whatever it is. Typing the next visible
 *   character while whitespace is pending also applies the run first, so
 *   indentation and line breaks can never cause a mismatch.
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

    const expected = this.target.slice(
      this.pos + snap.length,
      this.pos + snap.length + typed.length
    );
    if (expected !== typed) {
      return { kind: 'reject' };
    }
    this.pos += snap.length + typed.length;
    return { kind: 'insert', text: this.absorbTrailingWhitespace(snap + typed) };
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
   */
  fillWord(): string {
    if (this.done) {
      return '';
    }
    const rest = this.remaining;
    const leading = /^\s*/.exec(rest)![0].length;
    let end = leading;
    if (isWordChar(rest[end])) {
      while (end < rest.length && isWordChar(rest[end])) end++;
    } else {
      while (end < rest.length && isSymbol(rest[end])) end++;
    }
    this.pos += end;
    return this.absorbTrailingWhitespace(rest.slice(0, end));
  }

  /** Everything still untyped — used when a section is skipped. */
  fillRest(): string {
    const text = this.remaining;
    this.pos = this.target.length;
    return text;
  }

  private whitespaceRunAhead(): string {
    let end = this.pos;
    while (end < this.target.length && /\s/.test(this.target[end])) {
      end++;
    }
    return this.target.slice(this.pos, end);
  }
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}_$]/u.test(char);
}

function isSymbol(char: string | undefined): boolean {
  return char !== undefined && !/\s/.test(char) && !isWordChar(char);
}
