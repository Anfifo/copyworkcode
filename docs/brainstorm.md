# Brainstorm

Parking lot for ideas that are not committed work. Each entry keeps its reasoning: why
it's parked, what it would buy, what it would cost. Ideas good enough to act on get
promoted to [todo.md](todo.md); ideas we decide against **stay here** with the rationale,
so they don't get re-proposed from scratch. Decided-and-built things graduate to
[design.md](design.md).

## Parked (worth revisiting)

### Expandable per-region change history

Review works on the net diff, but each changed region could expand to show the sequence
of agent edits (and intents) that produced it — including abandoned attempts.

- **Upside:** abandoned approaches have real learning value ("it tried X, then backed
  out"); makes the intent story richer than a single final annotation.
- **Downside:** significant state to correlate events to regions across file mutations;
  none of the core goals need it.
- **Status:** deferred until the net-diff review loop works end to end.

### Blocking gate mode (per-session toggle)

The rejected-for-v1 enforcement model — agent edits land in a shadow buffer, the real
file only changes once retyped — could return later as an opt-in mode for careful work.

- **Upside:** hard guarantee that nothing unreviewed ever runs; some users will want it
  for critical files.
- **Downside:** breaks any agent that runs/tests its own edits mid-task, which is most of
  them; doubles the enforcement surface to build and test.
- **Status:** parked until the debt model proves itself; would need a per-file or
  per-session scope to be usable at all.

### Git-aware baselines

Baseline snapshots don't understand git: a branch switch changes files without anyone
"editing" them, which the diff will misread as reviewable change.

- **Upside:** removes the biggest source of false debt for anyone using branches.
- **Downside:** entangles the extension with repo state (checkouts, rebases, stashes);
  needs careful rules about what resets a baseline.
- **Status:** accepted as a v1 known hole (see design.md); promote once it bites in real
  use.

### Agent-instruction nudge for better intent

Transcript text before an edit is often thin ("now let me fix the import"). The extension
could offer a one-click snippet added to the user's agent instructions asking it to state
the goal of each change before editing.

- **Upside:** directly improves goal #4 (intent alongside diff) at near-zero cost.
- **Downside:** touches the user's agent configuration, which is theirs; must be
  suggest-only, never automatic.
- **Status:** revisit once intent extraction exists and its baseline quality is known.

### Quick-fill for low-value regions

Beyond fill-next-line: a fill-region control for boilerplate the user recognizes at a
glance (import blocks, generated tables, mechanical renames), recorded as its own status
("filled") distinct from typed and skipped.

- **Upside:** keeps friction proportional to learning value; probably the difference
  between the tool feeling fair and feeling like punishment on mechanical changes.
- **Downside:** every convenience is a hole in goals 1–3; a too-easy fill becomes the
  default gesture. Needs limits (size cap? per-review quota?) before it exists.
- **Status:** design alongside the retype experience, not after it.

## Rejected (kept for the record)

### Shareable proof-of-review for teams

Attaching "reviewed by typing" evidence to PRs for reviewers or employers.

- **Why rejected:** turns a personal learning mirror into surveillance; demands
  tamper-evidence machinery and privacy answers the product doesn't otherwise need. Stats
  are personal-only by design (2026-08-16).

### Per-event replay as the unit of review

Reviewing each captured change individually, in order.

- **Why rejected:** events go stale — later edits, formatters, and agent iteration
  invalidate earlier diffs, and volume multiplies. Net diff vs. baseline chosen instead
  (2026-08-16, see design.md).
