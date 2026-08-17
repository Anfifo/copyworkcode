import { ChangeEvent } from '../types';

export interface ParseResult {
  events: ChangeEvent[];
  /** Trailing partial line, to be prepended to the next chunk. */
  remainder: string;
}

/**
 * Parse a chunk of the append-only events log (JSON lines). Tolerates a
 * partial trailing line (the writer may be mid-append) and corrupt lines.
 * Events whose id is already in `seen` are dropped; new ids are added to it.
 */
export function parseEventChunk(
  chunk: string,
  previousRemainder: string,
  seen: Set<string>
): ParseResult {
  const lines = (previousRemainder + chunk).split('\n');
  const remainder = lines.pop() ?? '';

  const events: ChangeEvent[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let event: ChangeEvent;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // tolerate a corrupt line rather than losing the tail
    }
    if (!event.id || !event.file || seen.has(event.id)) continue;
    seen.add(event.id);
    events.push(event);
  }
  return { events, remainder };
}
