/**
 * A single AI-made (or suspected AI-made) change to a file.
 *
 * Events are append-only records in `.copyworkcode/events.jsonl`; review status
 * lives separately in the review state so the event log is never rewritten.
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
    | {
        kind: 'edit';
        oldText: string;
        newText: string;
        /** Full file content from before the edit, when small enough to keep. */
        baseContent?: string;
      }
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

export type ReviewStatus = 'unreviewed' | 'reviewed' | 'skipped' | 'auto-skipped';
