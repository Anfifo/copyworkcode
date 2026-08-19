/**
 * A single AI-made (or suspected AI-made) change to a file.
 *
 * Events are append-only records in `.copyworkcode/events.jsonl`. They are not
 * the unit of review — review debt is the per-file diff against the baseline
 * snapshot — but they annotate that diff: they mark which files changed at the
 * hand of an agent and carry the intent pointers for those changes.
 */
export interface ChangeEvent {
  /** Unique id, assigned by whichever detector produced the event. */
  id: string;
  /** ISO-8601 time the change was detected. */
  timestamp: string;
  /** How the change was detected. Hook events are precise; heuristic events are candidates. */
  source: 'agent-hook' | 'heuristic';
  /** Identifier of the producing agent for hook events, e.g. "claude-code". */
  agent?: string;
  /** Absolute path of the changed file. */
  file: string;
  /** Tool that made the change, as reported by the agent (e.g. "Edit", "Write"). */
  toolName?: string;
  /** The change content, when the detector could capture it. */
  change?:
    | { kind: 'edit'; oldText: string; newText: string }
    | { kind: 'write'; content: string };
  /**
   * Pointer for recovering the agent's stated intent later: transcript location
   * plus ids to correlate this change with the message that produced it.
   */
  intentRef?: {
    transcriptPath: string;
    sessionId?: string;
    toolUseId?: string;
  };
}

/** One completed review of a file's debt (typed out, or skipped some way). */
export interface ReviewRecord {
  /** Absolute path of the reviewed file. */
  file: string;
  /** ISO-8601 completion time. */
  at: string;
  outcome: 'typed' | 'skipped' | 'auto-skipped';
  /** Section counts for typed reviews (a review can mix typing and skips). */
  hunksTyped?: number;
  hunksSkipped?: number;
  /** Deletion-only sections acknowledged with one action. */
  hunksConfirmed?: number;
  /** Sections the reviewer wrote themselves instead of reproducing. */
  hunksEdited?: number;
}
