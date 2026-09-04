/**
 * What the change set page is reviewing: which files it holds, what each region
 * of them still owes, and what a gesture from the page comes to.
 *
 * Editor-independent, and deliberately so. The rules that matter most on this
 * surface are the ones about *when* a gesture counts — a key the region does not
 * owe changes nothing and takes no file over, a gesture aimed at progress the
 * page no longer holds is dropped, the last region claimed finishes the file —
 * and none of them need a webview or a file system to be true. The panel keeps
 * what genuinely needs the editor: the page itself, reading files, moving
 * baselines, writing the review log.
 *
 * A gesture is worked out in two steps, because the middle of it has to await.
 * `resolve` decides what a gesture comes to while changing nothing; the caller
 * then hands the file over from whatever surface had it, which is asynchronous;
 * `commit` applies the result. The state the resolution was worked out against
 * is carried between the two, so a gesture aimed at progress that something else
 * replaced in the meantime is dropped rather than applied to whatever took its
 * place.
 *
 * Positions here count characters into a region, and nothing moves under them:
 * the page reviews the file as it stood when the document was built. That is the
 * one thing this surface does not share with the editor review, which holds its
 * offsets in a live buffer and reconciles them against every edit that lands.
 */

import { FileView, ViewLine, ViewSection, sliceLines } from './changeSet';
import { RetypeEngine } from './retype';
import { SectionOutcome, SectionSeed } from './sections';

/** What one region owes, and how it stopped owing it. */
export interface SectionState {
  /** Characters of the region's target already covered. */
  position: number;
  /** True once a keystroke was matched here — what separates typed from
   * skipped when the region closes. */
  touched: boolean;
  outcome?: SectionOutcome;
}

/** One file on the page: what it looked like when it opened, and its progress. */
export interface ReviewFile {
  view: FileView;
  /** The content the page is reviewing — read once, so the payload, the gap
   * expansions and the baseline this ends up advancing to all agree. */
  current: string;
  /** Regions by their shared index, for a message to find one by number. */
  sections: ViewSection[];
  states: SectionState[];
}

/** One file as the page draws it: its document, plus where its regions stand. */
export interface FileDocument extends FileView {
  states: SectionState[];
}

/**
 * A file's progress on its way to an editor review, so the reviewer can write
 * their own code where the page can only type what is already there. Region
 * order is the two surfaces' shared handle, so the seed is simply the states in
 * that order, plus the region the reviewer asked from.
 */
export interface PageHandover {
  sections: SectionSeed[];
  /** The region to open at — the one the gesture came from. */
  index: number;
}

/** A gesture from the page aimed at one region. */
export type RegionGesture =
  | { type: 'type'; file: string; index: number; text: string }
  | { type: 'fillWord'; file: string; index: number }
  | { type: 'fillLine'; file: string; index: number }
  | { type: 'skip'; file: string; index: number }
  | { type: 'confirm'; file: string; index: number };

/** Everything the page is redrawn from. It holds no judgement of its own. */
export type Outbound =
  | { type: 'set'; baselineLabel: string; files: FileDocument[] }
  | { type: 'section'; file: string; index: number; state: SectionState }
  | { type: 'file'; file: string; states: SectionState[] }
  | { type: 'reject'; file: string; index: number }
  | { type: 'gap'; file: string; from: number; to: number; lines: ViewLine[] }
  | { type: 'done'; file: string; summary: string }
  | { type: 'handed'; file: string }
  | { type: 'askEdit' };

/**
 * What a gesture comes to, before any of it has happened. Only `apply` can take
 * a file over, which is the rule about wrong keys expressed as a type: a
 * rejected keystroke has no way to say it changed anything.
 */
export type Resolution =
  | { kind: 'ignore' }
  | { kind: 'reject'; posts: Outbound[] }
  | {
      kind: 'apply';
      file: string;
      index: number;
      /** The state this was worked out against, for `commit` to check it is
       * still the state the page holds. */
      at: SectionState;
      /** What the region's progress becomes. */
      next: SectionState;
      /** True while nothing has landed on this file yet: committing makes the
       * page its review surface, so whatever had it must let go first. */
      takesOver: boolean;
    };

/** A file every region of which is now accounted for. */
export interface FinishedFile {
  file: string;
  /** What the page actually reviewed — what a baseline advance moves to, rather
   * than whatever is on disk by now. */
  content: string;
  counts: Record<SectionOutcome, number>;
  /** The file-level outcome for the review log. */
  outcome: 'typed' | 'skipped';
  /** One line saying how the file was dealt with. */
  summary: string;
}

/** What committing a gesture came to. */
export interface Commit {
  posts: Outbound[];
  finished?: FinishedFile;
}

/** Coverage of one file on the page, in the page's own terms. */
export interface PageProgress {
  claimed: number;
  total: number;
}

export class ChangeSetReview {
  private files = new Map<string, ReviewFile>();
  /** Files the page took over, so whatever had one is only told once. */
  private taken = new Set<string>();
  /**
   * Files the page handed to an editor review, against whether it had taken
   * them over first. Handing one over is a deliberate exit rather than a
   * collision — the progress went with it — so the page stops answering for
   * these entirely: no gesture reaches them, no row reads from them, and the
   * drop an editor review would otherwise trigger has nothing left to do. The
   * flag is what a failed handover is put back from.
   */
  private handed = new Map<string, boolean>();

  /** Replace the document. Ownership goes with it: this is a different read. */
  load(files: readonly ReviewFile[]): void {
    this.files = new Map(files.map((live) => [live.view.file, live]));
    this.taken.clear();
    this.handed.clear();
  }

  clear(): void {
    this.files.clear();
    this.taken.clear();
    this.handed.clear();
  }

  get size(): number {
    return this.files.size;
  }

  has(file: string): boolean {
    return this.files.has(file);
  }

  fileAt(file: string): ReviewFile | undefined {
    return this.files.get(file);
  }

  /** True once a gesture has landed on this file, making the page its surface. */
  owns(file: string): boolean {
    return this.taken.has(file);
  }

  /** True once this file went to an editor review, progress and all. */
  handedOver(file: string): boolean {
    return this.handed.has(file);
  }

  /**
   * How far this file has got here, for the queue row. Undefined until a gesture
   * makes the page this file's surface: a file the page merely holds is every
   * file in the change set, which says nothing about where the reviewer is.
   */
  progressFor(file: string): PageProgress | undefined {
    const live = this.files.get(file);
    if (!live || !this.taken.has(file)) return undefined;
    const claimed = live.states.filter((state) => state.outcome !== undefined).length;
    // A file finished here is a review that happened, not one in progress: its
    // baseline moved when it closed, so debt standing against it again is a new
    // change this page has not read.
    if (claimed === live.states.length) return undefined;
    return { claimed, total: live.states.length };
  }

  /** Whether any file here has a reading the queue is showing, so a caller can
   * tell whether discarding this review is something the rows have to hear. */
  get reported(): boolean {
    for (const file of this.taken) {
      if (this.progressFor(file) !== undefined) return true;
    }
    return false;
  }

  /** The whole document, as the page is sent it. */
  document(baselineLabel: string): Outbound {
    return {
      type: 'set',
      baselineLabel,
      files: [...this.files.values()].map((live) => ({
        ...live.view,
        states: live.states,
      })),
    };
  }

  /**
   * What a gesture comes to, changing nothing. Worked out before the page takes
   * the file over, because a key this region does not owe is not a review
   * gesture, and it must not be the thing that ends a review running elsewhere.
   */
  resolve(gesture: RegionGesture): Resolution {
    const live = this.files.get(gesture.file);
    const section = live?.sections[gesture.index];
    const state = live?.states[gesture.index];
    if (!live || !section || !state || state.outcome !== undefined) {
      return { kind: 'ignore' };
    }
    // A file handed to an editor review is not this page's to move any more,
    // and taking it back on a keystroke would undo a handover the reviewer
    // asked for — with their own writing already in the file.
    if (this.handed.has(gesture.file)) return { kind: 'ignore' };
    const spot = { file: gesture.file, index: gesture.index };
    const takesOver = !this.taken.has(gesture.file);

    // A deletion-only region has nothing to type: one action acknowledges it.
    if (gesture.type === 'confirm' || section.kind === 'confirm') {
      return {
        kind: 'apply',
        ...spot,
        at: state,
        next: { ...state, outcome: 'confirmed' },
        takesOver,
      };
    }

    const engine = new RetypeEngine(section.target, state.position);
    let touched = state.touched;
    switch (gesture.type) {
      case 'type':
        if (engine.handleInput(String(gesture.text ?? '')).kind === 'reject') {
          // Nothing lands in the file on a wrong key here — the page has no
          // file to land it in — so saying so is the whole answer.
          return { kind: 'reject', posts: [{ type: 'reject', ...spot }] };
        }
        touched = true;
        break;
      case 'fillWord':
        engine.fillWord();
        break;
      case 'fillLine':
        engine.fillLine();
        break;
      case 'skip':
        engine.fillRest();
        // Filling the rest is not typing it, whatever was typed before.
        touched = false;
        break;
      default:
        return { kind: 'ignore' };
    }

    const next: SectionState = { position: engine.position, touched };
    if (engine.position >= section.target.length) {
      next.outcome = touched ? 'typed' : 'skipped';
    }
    return { kind: 'apply', ...spot, at: state, next, takesOver };
  }

  /**
   * The page becomes this file's review surface. Recorded before the handover it
   * implies has finished, so every later gesture on the file sees that it has
   * been asked for already rather than asking again.
   */
  takeOver(file: string): void {
    this.taken.add(file);
  }

  /**
   * Apply a resolution, unless the file moved out from under it while the
   * handover was in flight. Two ways that happens, and either one drops the
   * gesture.
   *
   * The page may no longer own the file. That is the ordinary collision: an
   * editor review started here, and it catches the case where the page had
   * nothing typed yet, since untouched progress is given up by leaving it
   * exactly as it was and there is no change of state to notice. So a committed
   * gesture is always a gesture on a file the page owns, which is what
   * `takeOver` is for.
   *
   * Or the progress the resolution was worked out against may not be the
   * progress the page holds any more — the file was given up and taken back
   * while this gesture was in flight. A resolution carries a position reached
   * from a particular state, so applying it to a state it never saw would move
   * the region somewhere neither surface asked for.
   */
  commit(resolution: Resolution): Commit | undefined {
    if (resolution.kind !== 'apply') return undefined;
    const live = this.files.get(resolution.file);
    if (!live || !this.taken.has(resolution.file)) return undefined;
    if (live.states[resolution.index] !== resolution.at) return undefined;

    live.states[resolution.index] = resolution.next;
    const posts: Outbound[] = [
      {
        type: 'section',
        file: resolution.file,
        index: resolution.index,
        state: resolution.next,
      },
    ];
    if (live.states.some((state) => state.outcome === undefined)) {
      return { posts };
    }
    const finished = this.finish(live);
    posts.push({ type: 'done', file: finished.file, summary: finished.summary });
    return { posts, finished };
  }

  /**
   * Another surface took this file over: drop what the page had on it. The
   * regions come back owed rather than disappearing, because the file is still
   * part of the change set and still has to be read — it is only being reviewed
   * somewhere else now.
   */
  dropFile(file: string): Outbound | undefined {
    const live = this.files.get(file);
    this.taken.delete(file);
    // The editor review of a file this page handed over is the one it asked
    // for: the progress is already there, and owing these regions again would
    // be the page taking back what it gave.
    if (!live || this.handed.has(file)) return undefined;
    const started = live.states.some((state) => state.position > 0 || state.outcome);
    // A file already finished here is not work outstanding, it is a record of a
    // review that happened — and its baseline moved when it did. Owing its
    // regions again would be the page contradicting itself.
    const finished = live.states.every((state) => state.outcome !== undefined);
    if (!started || finished) return undefined;
    live.states = live.sections.map(() => ({ position: 0, touched: false }));
    return { type: 'file', file, states: live.states };
  }

  /**
   * Give this file to an editor review, carrying what the page covered: every
   * region's position and outcome, and the region the reviewer asked from.
   *
   * The page stops being this file's surface, which is the point — the editor is
   * where a reviewer writes their own code, and one surface owns a file at a
   * time.
   * What is different from every other way of losing a file is that nothing is
   * given up: the seed is the page's progress, and the review that receives it
   * starts where the reviewer stopped rather than at zero.
   *
   * Nothing here reaches an editor; the caller does that, and puts this back
   * with `unhand` if it could not.
   */
  handOver(file: string, index: number): PageHandover | undefined {
    const live = this.files.get(file);
    if (!live || this.handed.has(file)) return undefined;
    if (index < 0 || index >= live.sections.length) return undefined;
    // A file every region of which is accounted for is a review that already
    // happened here, and its baseline moved when it closed. There is no version
    // of the change left to rewrite.
    if (live.states.every((state) => state.outcome !== undefined)) return undefined;
    this.handed.set(file, this.taken.has(file));
    this.taken.delete(file);
    return {
      index,
      sections: live.states.map((state) => ({
        position: state.position,
        touched: state.touched,
        outcome: state.outcome,
      })),
    };
  }

  /** The handover did not happen: the page has this file back, as it was. */
  unhand(file: string): void {
    const was = this.handed.get(file);
    if (was === undefined) return;
    this.handed.delete(file);
    if (was) this.taken.add(file);
  }

  /** The lines a gap is holding back, from the content the page is reviewing. */
  gap(file: string, from: number, to: number): Outbound | undefined {
    const live = this.files.get(file);
    if (!live || !Number.isFinite(from) || !Number.isFinite(to)) return undefined;
    return { type: 'gap', file, from, to, lines: sliceLines(live.current, from, to) };
  }

  /** How a file was dealt with, once every region of it is accounted for. */
  private finish(live: ReviewFile): FinishedFile {
    const counts: Record<SectionOutcome, number> = {
      typed: 0,
      skipped: 0,
      confirmed: 0,
      edited: 0,
    };
    for (const state of live.states) {
      if (state.outcome) counts[state.outcome]++;
    }
    this.taken.delete(live.view.file);
    const parts = [`${counts.typed} typed`, `${counts.skipped} skipped`];
    if (counts.confirmed > 0) parts.push(`${counts.confirmed} deletion(s) confirmed`);
    if (counts.edited > 0) parts.push(`${counts.edited} written yourself`);
    return {
      file: live.view.file,
      content: live.current,
      counts,
      // Any region reproduced, acknowledged or rewritten makes this a review
      // that happened — the same reading the editor review's record takes.
      outcome:
        counts.typed + counts.confirmed + counts.edited > 0 ? 'typed' : 'skipped',
      summary: parts.join(', '),
    };
  }
}
