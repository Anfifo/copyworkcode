import * as vscode from 'vscode';

/**
 * Motion for the retype overlay. Every animation here is decoration-only: it
 * reacts to what the matching engine already decided and never gates or
 * delays it, so a keystroke is accepted at the same moment whatever the
 * animation level is.
 *
 * Editor decorations compile to generated CSS rules, which means keyframes
 * cannot be declared and `transform` is ignored on inline text spans — there
 * is no way to scale, slide or rotate a character. Animation is therefore
 * frame-stepped from here: each effect is a fixed ladder of decoration types
 * applied to a range in turn, one frame per clock tick, until the range falls
 * off the end of the ladder. Only properties that leave layout alone are
 * animated (opacity, background, weight, border), so text never shifts under
 * the cursor while it is being typed.
 */

/** How much motion the review overlay adds. */
export type AnimationLevel = 'full' | 'subtle' | 'off';

/** One clock tick. Every ladder shares it, so its length sets the grain of
 * every effect: a ladder's duration is its frame count times this. */
const FRAME_MS = 40;

/** Slower single-frame hold used when animation is off — long enough to read
 * as a flash rather than a flicker. */
const STATIC_MS = 250;

/** A wipe stretches over one segment per this many characters, so a short
 * word finishes at once and a long section sweeps. */
const CHARS_PER_SEGMENT = 4;

/** Ceiling on a wipe's segments: a whole-file section sweeps coarsely rather
 * than scheduling hundreds of frames. */
const MAX_SEGMENTS = 8;

/** Ceiling on ranges animating at once. Typing faster than a ladder decays
 * leaves a trail of recent strikes behind the cursor, which is the point —
 * but the trail is bounded so a burst cannot grow the per-tick repaint. */
const MAX_IN_FLIGHT = 24;

/**
 * A decay animation: a range enters at frame 0 and advances one frame per
 * tick until it drops off the end. The clock only runs while something is in
 * flight, so an idle review costs nothing.
 */
class Ladder implements vscode.Disposable {
  private entries: { range: vscode.Range; frame: number }[] = [];
  private timer?: ReturnType<typeof setInterval>;
  /** Which frames currently have ranges painted, so a tick only touches the
   * frames that actually changed instead of all of them. */
  private painted: boolean[];

  constructor(
    private readonly frames: vscode.TextEditorDecorationType[],
    private readonly frameMs: number,
    private readonly editors: () => readonly vscode.TextEditor[]
  ) {
    this.painted = frames.map(() => false);
  }

  /** Zero for a level that animates nothing — callers can skip their work. */
  get length(): number {
    return this.frames.length;
  }

  /** `delay` holds the range off the ladder for that many ticks, which is how
   * a wipe staggers its segments into a sweep. */
  push(range: vscode.Range, delay = 0): void {
    if (this.frames.length === 0 || range.isEmpty) return;
    this.entries.push({ range, frame: -delay });
    if (this.entries.length > MAX_IN_FLIGHT) {
      this.entries.splice(0, this.entries.length - MAX_IN_FLIGHT);
    }
    this.paint();
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), this.frameMs);
    }
  }

  /** Drop what is in flight and animate only this range — for effects where
   * the newest event replaces the previous one rather than trailing it. */
  restart(range: vscode.Range): void {
    this.entries = [];
    this.push(range);
  }

  clear(): void {
    this.entries = [];
    this.stop();
    // Force a repaint of every frame, not just the ones believed to be dirty:
    // clearing has to leave nothing behind even if the bookkeeping drifted.
    this.painted.fill(true);
    this.paint();
  }

  dispose(): void {
    this.clear();
    for (const frame of this.frames) frame.dispose();
  }

  private tick(): void {
    for (const entry of this.entries) entry.frame++;
    this.entries = this.entries.filter((e) => e.frame < this.frames.length);
    this.paint();
    if (this.entries.length === 0) this.stop();
  }

  private paint(): void {
    const editors = this.editors();
    for (let frame = 0; frame < this.frames.length; frame++) {
      const ranges = this.entries
        .filter((e) => e.frame === frame)
        .map((e) => e.range);
      if (ranges.length === 0 && !this.painted[frame]) continue;
      this.painted[frame] = ranges.length > 0;
      for (const editor of editors) {
        editor.setDecorations(this.frames[frame], ranges);
      }
    }
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

/**
 * The retype overlay's animations, as three gestures the controller calls:
 * `strike` for an accepted keystroke, `wipe` for a run filled in without
 * typing, `reject` for a keystroke that did not match.
 */
export class TypingFx implements vscode.Disposable {
  private level: AnimationLevel;
  private strikes!: Ladder;
  private rejects!: Ladder;
  /** The document being reviewed; the target editors are resolved from it on
   * every paint, so a split view animates in both panes and a closed one
   * simply stops receiving frames. */
  private document?: vscode.TextDocument;
  private configGuard: vscode.Disposable;

  constructor() {
    this.level = readLevel();
    this.build();
    this.configGuard = vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('copyworkcode.animations')) return;
      const level = readLevel();
      if (level === this.level) return;
      this.level = level;
      this.build();
    });
  }

  /** Point the animations at the document under review. */
  bind(document: vscode.TextDocument): void {
    if (this.document !== document) this.clear();
    this.document = document;
  }

  /** A keystroke landed: the run it produced flashes and fades in, so the
   * character reads as struck into place rather than simply appearing. */
  strike(range: vscode.Range): void {
    this.strikes.push(range);
  }

  /**
   * A run was filled in without typing it (a word, a line, a whole section).
   * The same strike decay sweeps across it left to right instead of lighting
   * the run at once, so a fill reads as filled in rather than blinked in.
   */
  wipe(range: vscode.Range): void {
    const document = this.document;
    if (!document || this.strikes.length === 0 || range.isEmpty) return;
    const start = document.offsetAt(range.start);
    const end = document.offsetAt(range.end);
    const total = end - start;
    if (total <= 0) return;
    const segments = Math.min(
      MAX_SEGMENTS,
      Math.max(1, Math.ceil(total / CHARS_PER_SEGMENT))
    );
    const size = Math.ceil(total / segments);
    for (let i = 0; i * size < total; i++) {
      const from = start + i * size;
      this.strikes.push(
        new vscode.Range(
          document.positionAt(from),
          document.positionAt(Math.min(from + size, end))
        ),
        i
      );
    }
  }

  /** The keystroke did not match: the target it missed flares and fades out. */
  reject(range: vscode.Range): void {
    this.rejects.restart(range);
  }

  /** Drop every animation in flight — the review ended or moved on. */
  clear(): void {
    this.strikes.clear();
    this.rejects.clear();
  }

  dispose(): void {
    this.configGuard.dispose();
    this.strikes.dispose();
    this.rejects.dispose();
    this.document = undefined;
  }

  private editors(): readonly vscode.TextEditor[] {
    const document = this.document;
    if (!document) return [];
    return vscode.window.visibleTextEditors.filter((e) => e.document === document);
  }

  /**
   * Rebuild both ladders for the current level. The decoration types belong to
   * the ladders, so the old ones are disposed here — which also lifts whatever
   * they had painted, leaving the overlay clean across a level change.
   */
  private build(): void {
    this.strikes?.dispose();
    this.rejects?.dispose();
    const editors = () => this.editors();
    const type = (options: vscode.DecorationRenderOptions) =>
      vscode.window.createTextEditorDecorationType(options);
    const impact = new vscode.ThemeColor('editor.wordHighlightStrongBackground');
    const afterglow = new vscode.ThemeColor('editor.wordHighlightBackground');
    const error = new vscode.ThemeColor('inputValidation.errorBackground');

    // The reveal is an opacity ramp because the alternative — animating the
    // text colour — would paint over syntax highlighting. Opacity applies to
    // the whole span, background included, so the flash is deliberately
    // strongest on the frame where the character is dimmest: the glow hands
    // off to the character rather than competing with it.
    const strikeFrames: vscode.DecorationRenderOptions[] =
      this.level === 'full'
        ? [
            {
              opacity: '0.5',
              backgroundColor: impact,
              borderRadius: '2px',
              fontWeight: 'bold',
            },
            { opacity: '0.78', backgroundColor: afterglow, borderRadius: '2px' },
            { opacity: '0.92' },
          ]
        : this.level === 'subtle'
          ? [{ opacity: '0.6' }, { opacity: '0.85' }]
          : [];

    // Full strength for the first two frames — the miss has to register
    // before it starts fading — then a decay to nothing.
    const rejectFrames: vscode.DecorationRenderOptions[] =
      this.level === 'full'
        ? [
            {
              backgroundColor: error,
              fontWeight: 'bold',
              borderWidth: '0 0 0 2px',
              borderStyle: 'solid',
              borderColor: new vscode.ThemeColor('editorError.foreground'),
            },
            { backgroundColor: error },
            { backgroundColor: error, opacity: '0.75' },
            { backgroundColor: error, opacity: '0.5' },
            { backgroundColor: error, opacity: '0.28' },
          ]
        : this.level === 'subtle'
          ? [
              { backgroundColor: error },
              { backgroundColor: error, opacity: '0.6' },
              { backgroundColor: error, opacity: '0.3' },
            ]
          : [{ backgroundColor: error }];

    this.strikes = new Ladder(strikeFrames.map(type), FRAME_MS, editors);
    this.rejects = new Ladder(
      rejectFrames.map(type),
      this.level === 'off' ? STATIC_MS : FRAME_MS,
      editors
    );
  }
}

function readLevel(): AnimationLevel {
  const level = vscode.workspace
    .getConfiguration('copyworkcode')
    .get<string>('animations');
  return level === 'subtle' || level === 'off' ? level : 'full';
}
