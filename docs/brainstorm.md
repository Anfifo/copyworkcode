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

Beyond fill-word and fill-line: a fill-region control for boilerplate the user recognizes
at a glance (import blocks, generated tables, mechanical renames), recorded as its own
status ("filled") distinct from typed and skipped.

- **Upside:** keeps friction proportional to learning value; probably the difference
  between the tool feeling fair and feeling like punishment on mechanical changes.
- **Downside:** every convenience is a hole in goals 1–3; a too-easy fill becomes the
  default gesture. Needs limits (size cap? per-review quota?) before it exists.
- **Status:** the per-word and per-line fills exist (both counted as skipped, never as
  typed); the region-sized fill and a distinct "filled" status stay parked until real use
  shows where the line between fair and too-easy sits.

### Syntax highlighting on the change set page

The page draws code with no syntax colour at all: dim for what is still owed, full strength
for what has been typed, the deleted-resource colour for what went. A bundled highlighter
would colour it the way an editor does.

- **Upside:** code reads faster when it is coloured, and the page is the surface with the
  most code on screen at once.
- **Downside:** a runtime dependency and a language map to keep, and — the real cost — a
  second loud colour scheme competing with the only distinction the page exists to draw.
  That is the mistake the diff-editor surface was rejected for, in a new place.
- **Status:** parked (2026-08-20) in favour of shipping the review's own colour language
  first. The page renders every line as its own element, so a highlighter can be dropped in
  later without changing what the extension sends it. Revisit once real use says whether
  uncoloured code on the page reads as calm or as flat.

## Rejected (kept for the record)

### Shareable proof-of-review for teams

Attaching "reviewed by typing" evidence to PRs for reviewers or employers.

- **Why rejected:** turns a personal learning mirror into surveillance; demands
  tamper-evidence machinery and privacy answers the product doesn't otherwise need. Stats
  are personal-only by design (2026-08-16).

### Ordered walk as the review's structure

Sections as a strict sequence, with the flow always pointing at "the next one".

- **Why rejected:** it only worked while the review owned the caret, and it doesn't —
  clicking anywhere is free even with the buffer read-only, and a flow that insists on the
  next section spends its time fighting the user for it. Sections became a set with
  per-section progress, keeping the ordered walk as the default motion and dropping it as a
  rule (2026-08-19, see design.md). The byte-identical resume check went with it, for
  answering the wrong question about a parked review; parking itself came back without one,
  since per-section progress is remapped as the file moves (see design.md).

### Marking changed code outside a review

A layer that marked every open file's changes against its baseline with no review running —
a light dim, a gutter icon, a scrollbar mark and the removal boundary — as "the tool at
rest", and a way to look at recent changes without committing to review them.

- **Why rejected:** built, lived with, and removed (2026-08-20). It spoke the review
  surface's language outside a review: the removal mark was the same decoration, and once
  the review's dim was lightened so the next character stayed legible, the two shades were
  near-neighbours. Nothing on screen said which state you were in, which is the one thing
  these visuals have to say. The queue, the file-decoration tint and Alt+D already answer
  "what changed here" without dressing an ordinary editor as a review. A variant that
  inverted the polarity — dimming the *unchanged* context so changes pop — was rejected
  before that (2026-08-19) for its own reason: it makes changed code the bright side, and
  the metaphor the product runs on is that unreviewed code is dim until you give it life by
  typing it.

### Rebuilding the review queue as a webview

A webview queue could colour the `+N −M` counts inline, which a native tree view cannot.

- **Why rejected:** it costs the file-icon theme (the exact thing being restored when the
  custom row icons were dropped), the container badge, and the native welcome content, all
  for inline colour on two numbers. A file-decoration provider tints the filename instead
  and the counts stay grey (2026-08-19). This was about the queue, not about pages: the
  change set page *is* one, and it earns it by holding a document of code rather than a list
  of files (see design.md).

### Per-event replay as the unit of review

Reviewing each captured change individually, in order.

- **Why rejected:** events go stale — later edits, formatters, and agent iteration
  invalidate earlier diffs, and volume multiplies. Net diff vs. baseline chosen instead
  (2026-08-16, see design.md).
