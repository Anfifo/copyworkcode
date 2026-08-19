# Design decisions

Working record of the architecture. Short on ceremony, long on "why".

## The core loop

AI-made code changes are captured as **change events**. Review debt, however, is not the
event queue itself: debt is defined **per file, as the net diff between the last-reviewed
baseline snapshot and the current content** (see "Unit of review" below). Changes apply to
files immediately — nothing blocks the AI's own build/test iteration. The user clears debt
by **retyping** the net change in a guided review flow, or by skipping it (manually, or
automatically via configurable file-pattern rules — lockfiles, generated code, etc.).

What this buys us, in order of priority:

1. **Actual review** — you can't skim what you have to type.
2. **Retention** — writing produces measurably better learning than reading.
3. **A measurable review signal** — typed vs. skipped is recorded per change.
4. **Intent alongside diff** — where the source tool exposes it, the AI's stated goal for
   a change is captured and shown next to it.

## Change detection: hybrid

Two detection layers, one event queue.

### Layer 1 — agent hook integration (precise, carries intent)

Tools that expose lifecycle hooks (Claude Code first) get a small hook script registered
for two moments around every file edit/write the agent performs:

- **Before the tool runs**, the hook snapshots the file's current content into
  `.copyworkcode/baselines/` — but only if no baseline exists yet. This preserves the
  pre-change state the review diff needs, even when the editor is closed, and never
  overwrites a baseline (that would erase unreviewed debt).
- **After the tool runs**, the hook appends a JSON change event to
  `.copyworkcode/events.jsonl`.

Key properties:

- **Works regardless of where the agent runs.** The hook runs inside the agent's process
  — external terminal, integrated terminal, another window. Events land in the workspace
  folder; the extension picks them up live via a file watcher, or catches up on next
  activation if the editor was closed during the session.
- **Intent is recoverable.** The hook records the session transcript path and tool-use id,
  so the extension can later extract the assistant's stated reasoning for that specific
  change and show it during review. What is stored is the pointer, not the conversation:
  the transcript remains the agent's own file, read on demand if a review asks for it.
- **Credentials are never copied.** Capture duplicates content by design — a baseline holds
  the pre-change version of a file and the event log holds the text of each edit — so a
  credentials file would end up written down twice over, inside a directory the workspace
  deliberately hides from `git status`. Files matching the exclusion list get neither: no
  baseline snapshot, no content in the event, and therefore no review debt, since a file
  with no baseline has none. The occurrence is still recorded, so an agent touching one is
  never invisible; only the text is withheld. The list is deliberately broad, because a
  false positive costs one un-reviewable file while a false negative writes a private key
  to disk — tempered in one place, where the `secret`/`credential` name rule applies to
  data and config files but not to source files, which are exactly what you want to
  review. The queue applies the same list independently, since git mode reports changes
  the hook never saw.
- **Capture is off until asked for, and reversible.** A single application-scoped setting
  (`copyworkcode.agentCapture`) is the only expression of intent; the extension's job is to
  make the settings file match it, installing the hook when it goes on and removing it when
  it goes off. Nothing is installed on activation, on enabling a workspace, or from a
  notification. An earlier version offered the hook in a one-click prompt when a workspace
  was enabled, and that was wrong for what it was asking: the file is global to every
  project and every terminal the agent runs in, which is precisely why one entry suffices
  and precisely why it should not be the by-product of dismissing a toast. Putting both
  directions in one toggle also means the way out is as discoverable as the way in — a tool
  that edits a config it doesn't own has to be removable by whoever it surprised.
- **The setting decides, so the two never drift.** Both palette commands write the setting
  rather than the file, and the hook is reconciled against it on activation and on every
  change. A machine that receives the preference through settings sync installs the hook
  itself, and the reconcile is idempotent in both directions — with capture off, the
  default, it returns without opening the settings file at all.
- **The settings file is never left half-written.** It belongs to the user and holds far
  more than this hook, so edits are surgical (entries are matched by script name, since the
  extension's install path moves with every update, and anything sharing an event or an
  entry is preserved) and the write goes to a temporary file renamed over the target, which
  is atomic within a directory. A failed write leaves the original intact.
- **It records only where invited.** The hook script no-ops in workspaces that haven't
  enabled the extension, so one user-wide entry never means recording everywhere.

### Layer 2 — editor heuristics (tool-agnostic fallback)

For everything else — other assistants, a whole file pasted from a chat window, external
tools writing to disk:

- Large multi-line insertions in the editor that don't match keystroke-by-keystroke typing
  (paste / programmatic apply) become candidate events.
- File watcher catches changes written to disk outside the editor.
- Known noise is excluded where detectable (git branch switches, formatters); anything
  ambiguous is presented as a candidate the user can dismiss.

Heuristic events carry no intent — that's inherent to the layer.

## Unit of review: net diff vs. baseline

Individual events go stale fast: by the time review happens, the agent may have rewritten
the same function five times, the user may have edited around it, or a formatter may have
run — so an event's literal before/after often no longer exists in the file. Per-event
replay was rejected for that reason.

Instead, the extension keeps a **per-file snapshot of the last-reviewed state** (the
baseline). Review debt for a file is the diff between its baseline and its current
content. Captured events are not the debt — they are **annotations** on that diff: they
mark which regions changed at the hand of an agent and carry the intent pointers for those
regions. Completing a review advances the baseline to the current content.

Mechanics of the store:

- One snapshot file per source file under `.copyworkcode/baselines/`, named by the
  percent-encoded workspace-relative path (forward slashes). Flat, greppable, no index to
  corrupt. The hook re-implements this naming in plain JS; the two must stay in sync.
- The *initial* baseline for a file is written by the capture hook just before the
  agent's first edit (see Layer 1). A brand-new file gets an empty baseline, so its whole
  content is debt. Files without a baseline have no debt — the extension only ever asks
  for review of changes it saw an agent make.
- The baseline advances when a review completes, when the user skips a file, or when an
  auto-skip glob matches a change event.
- Diffing is line-based, and line endings are normalized first: a CRLF/LF difference is
  never review debt.

Consequences:

- Agent iteration collapses to one review of the final result, not N intermediate states.
- Heuristic and hook events feed the same model; a region with no event behind it can
  still show up in the diff (e.g. the user's own edits) and is simply not flagged as
  agent-made.
- Baselines must be git-aware eventually (branch switches change files without anyone
  "editing" them); v1 may accept weirdness there, but it's a known hole, not a surprise.
  The git comparison mode below is not that fix, though it is a way out when snapshots
  have gone wrong: it ignores them entirely.

### Comparing against git instead

Snapshots only exist for changes something was watching. Work that landed while the
extension was off — or before it was installed — has no snapshot and therefore no debt,
so the queue reads "all clear" when there is plenty to review. The queue's header
therefore has a second mode: it switches the compared-against side from the last-reviewed
snapshot to the working tree's diff against a git revision (`HEAD` by default,
`copyworkcode.gitRef` for anything else). Everything downstream is untouched — same
sections, same retype flow, same on-demand diff — only the left-hand side differs.

It is an override, not a migration:

- Switching never touches the snapshot store, so the tracked queue returns exactly as it
  was. A half-reviewed backlog cannot be lost by looking at git for a while.
- Completing or skipping a review always advances the file's snapshot, in either mode.
  That is what lets a reviewed file leave both queues. Git keeps reporting the change
  until it is committed, so the git queue additionally hides files whose snapshot already
  matches what is on disk.
- The two queues answer different questions, and their contents differ on purpose: a
  committed-but-never-reviewed change is tracked debt and not a git change; an edit you
  made yourself is a git change and not tracked debt.
- Files git doesn't track yet are included, ignore rules still applying, so a file created
  from scratch reviews as one whole-file section. Binary files are left out — nothing to
  retype.
- The header names the revision while the mode is on. A queue that quietly answered a
  different question would be worse than no queue.

Git runs as a child process, which keeps the dependency to git being on `PATH` and nothing
else. A folder with no repository, or a revision that doesn't exist, refuses the switch
rather than showing an empty queue that reads as "all clear".

## Enforcement model: apply-now, retype-to-clear

Chosen over a blocking gate. A gate (AI writes to a shadow buffer, real file changes only
after retyping) gives a stronger guarantee but breaks agents that need to run and test
their own edits mid-task, which is most of them. Debt mode keeps the agent loop intact and
makes the review metric "debt cleared" rather than "gate passed".

## Review UI: real editor, not a webview

The review opens the actual file in a **normal editor** — not a diff view — and guides
retyping in place, walking the changed sections top to bottom. An earlier version used
the diff editor as the review surface and was rejected after real use: the global
red/green diff painting drowned out every cue the review added, so reviewing felt
indistinguishable from reading a diff. The review now owns its visuals, and the baseline
diff is one action away (an editor-title button and a lens action open it side by side)
instead of being the surface. Built on real text editors with decorations (not a
webview) so IntelliSense, navigation, and every language feature keep working while
reviewing. The user can freely look around the rest of the file mid-review.

What the reviewer sees: text not yet typed is dimmed; the active section carries a
whole-line highlight, a left border, and a scrollbar mark; and the exact run the next
keystroke should produce is highlighted at the cursor. A lens strip floats above the
active section with its position and progress ("Section 2/5 — typed 34/120") and
clickable fill-word (Right), fill-line (Alt+F), skip (Alt+S), show-diff (Alt+D), and stop
(Shift+Esc) actions. Every control's hover says what it does and ends with its key, so the
strip stays narrow and nothing has to be memorized to be usable. A mismatched keystroke
flares on the target it missed and fades out. The status bar mirrors position and
keybindings; clicking it — or Alt+J — snaps the viewport back to the typing position after
wandering off to read something else.

Typing has motion, because a surface that only dims and undims text reads as nothing
happening. An accepted keystroke flashes the run it produced and fades it in over about
120ms, so the character lands rather than simply appears; typing faster than that leaves a
short trail of settling characters behind the cursor. Text filled in rather than typed — a
word, a line, a whole section — gets the same treatment swept left to right, so a fill is
never mistakable for typing. A mismatch flares on the target it missed and decays over
about 200ms, which reads as a rejection rather than the static red block it replaced.

Editor decorations compile to generated CSS rules: keyframes cannot be declared, and
transforms are ignored on inline text spans, so a character cannot be scaled or slid.
Every effect is therefore frame-stepped from the extension — a ladder of decoration types
applied to a range in turn, one frame per clock tick — and animates only properties that
leave layout alone: opacity, background, border, and weight (a monospace bold face carries
the same advance width, so the impact frame cannot reflow the line). Motion that displaces
text was
considered and rejected: the one property that produces it, letter spacing, shifts the
whole rest of the line with it, and a surface being typed into cannot afford text that
jumps under the cursor. The clock runs only while something is in flight and the trail is
bounded, so an idle review costs nothing and a burst of fast typing cannot grow the
repaint. Animation is strictly decoration — it trails what the matching engine already
decided and can never delay or change what a keystroke does. `copyworkcode.animations`
sets the level: `full`, `subtle` (fades only, no flash), or `off`. Extensions get no
reduced-motion signal from the editor, and a surface that flashes on every keystroke needs
an off switch that is not a guess about the reader.

The right arrow is a control rather than navigation: inside a review there is nowhere
useful to move right, since everything to the right is text still owed, so the key fills
the next word instead — pending whitespace plus a run of identifier characters, or a run
of adjacent symbols so `=>` and `);` go in one press. It fills only when the cursor is at
the typing position; with a selection open, or after clicking away to read something else,
it moves as it always did, so a fill never happens where the reviewer isn't looking. Like
fill-line, filling is not typing: a section cleared entirely by fills is recorded as
skipped.

How the in-place retype works, given that changes are already applied to the file
(apply-now model): the buffer keeps its final content for the whole review and is never
edited by the flow. Each accepted keystroke advances a matching engine, restoring normal
rendering as the cursor moves. The user reads and reproduces real text in place — the
typing is the review — but since the buffer never changes, a review cannot dirty,
truncate, or lose the file, and stopping at any point just drops the overlay. This
matters most for a file the agent created from scratch (its baseline is empty, so the
entire file is one section): it reviews the same way, fully visible and dimmed until
typed, rather than presenting as an alarming empty buffer. Sections that only *removed*
lines are explicit stops in the walk: nothing to retype, so the lens strip reports how
many lines were deleted there and offers a one-click confirm, recorded separately from
typed and skipped counts.

Keystrokes are intercepted with a `type` command override while a review is active. That
is what guarantees completions, snippets, and auto-closing pairs can never insert text on
the user's behalf inside the review region — rather than trying to disable each editor
convenience individually. The reviewed editor is also marked read-only for the session:
printable input still reaches the override (the editor dispatches the `type` command
before its read-only check), while every editing gesture that bypasses it — backspace,
paste, drag-and-drop, line moves, undo, anything unforeseen — is inert instead of
editing the buffer behind the engine's back and killing the review. Blocking by
enumerating keybindings was tried first and rejected: the list can never be complete,
and every miss aborts someone's review. Enter and Tab are dispatched as editor commands
rather than `type` input, so both are rebound — scoped to the reviewed editor only — to
route through the matching engine and snap whitespace like any other formatting
keystroke. The read-only flag lifts when the review ends; if the review's editor is
already gone (its tab was closed), the reset runs when the file next becomes active.

Because the flow makes no edits of its own, any change to the document during a review
is by definition foreign — a formatter, an agent editing the file mid-review, a reload
from disk. Foreign changes invalidate the section offsets, so the review stops; the new
content is kept untouched and the debt stays in place.

One review is live at a time, but a review is not a commitment. Starting another file
**parks** the current one — its section, its position inside that section, and its
counters — and coming back resumes exactly there. Parking is not an outcome: nothing is
written, nothing is logged, and the file keeps its place in the queue with its position on
its row. An earlier version refused the second file outright ("a review is already in
progress"), which made every other file unreachable until the first was stopped and lost;
freedom to move matters more than a tidy single-session model. A parked position describes
offsets in the content it was parked on, so a file that changed in the meantime starts its
walk over rather than typing into stale offsets.

Closing the review tab parks as well — an accidental tab close is not a decision to throw
away typing — while stopping deliberately discards the position, so the next review of that
file starts clean. There are three visible ways to stop: Shift+Esc, a stop button in the
editor title bar, and the lens strip's Stop action. Marking a file reviewed from the queue
also drops whatever review state it had, live or parked, since its debt is being cleared
anyway. The start gate covers the whole async setup, so a doubled gesture (double-click on
a row, an impatient re-click) still collapses into one review, and asking to review the
file already under review just jumps back to its typing position.

### The review queue view

One row per file waiting for review, in the extension's own activity-bar panel, biggest
change first — change size is what a reviewer picks by, so it leads the row: `+12 −3`, then
the review's position if one is parked there, then how many agent edits are behind it, then
the directory. A tree row cannot colour its own text, so the colour lives on the icon,
which doubles as the shape of the change: additions only, deletions only, or both. The
hover carries the long form — path, counts against whatever the current baseline is, parked
position, agent edits, when it was last reviewed and how — the container badge carries the
pending count, and one inline button marks a file reviewed without typing it.

### Retype matching rules

Typing in a real buffer means the editor itself modifies text the user didn't type
(auto-indent, auto-closing brackets, format-on-type). The matching policy:

- **Code is typed character-for-character.** Editor completions and snippets are
  suppressed inside the review region — tab-completing whole lines would defeat the
  entire point.
- **Whitespace snaps to the target.** Any whitespace keystroke (space, enter, tab) at a
  formatting boundary auto-applies whatever whitespace the target text actually has —
  press space where the target has a newline and the newline is inserted for you, and
  vice versa. Typing the next visible character while whitespace is pending applies the
  run too, so indentation never has to be typed. Line endings and auto-indent artifacts
  can never cause a mismatch.
- **Trailing whitespace is absorbed.** When only whitespace remains in a section, the
  last accepted keystroke completes it — otherwise every section would end on an
  invisible pending newline the user has to guess at.
- **Strictness is a setting** (not yet implemented; see todo). A permissive mode lets the
  user deliberately deviate — reformat or improve as they type — which feeds the
  deviation flow below (stale-context notification + re-sync prompt) instead of counting
  as a mismatch. The current behavior is the strict mode: mismatched keystrokes insert
  nothing.

## Review stats: personal only

The typed/skipped record is a private mirror for the user's own discipline and learning —
not evidence for teams, reviewers, or employers. That keeps skip a frictionless single
click (gaming the metric is only self-deception), keeps state as plain local JSON with no
tamper-evidence machinery, and keeps the extension out of surveillance territory.

## Known risks (accepted, tracked)

- **Secrets in an unusually named file.** Content exclusion is pattern-based and not
  configurable, so a credentials file that matches nothing on the list is still copied into
  a baseline and the event log. The patterns cover the conventional names; a project that
  keeps its secrets somewhere idiosyncratic is not protected, and there is no per-project
  override yet.
- **Intent quality.** The transcript text preceding a tool call is often thin ("now let
  me fix the import"). Intent must be extracted eagerly (transcripts get compacted or
  deleted), and genuinely useful rationale may need users to nudge their agent's
  instructions to state goals before editing.
- **Core-loop validation.** The real product risk is retyping feeling like punishment.
  The retype loop should reach crappy-but-real as early as possible to test the
  hypothesis before any polish work.

## Repo layout

- `src/` — extension source (TypeScript). `src/core/` holds editor-independent logic
  (diff, retype matching, baseline store, event-log parsing, git baseline reads, agent
  settings transforms) so it can be unit-tested with plain Node. `src/typingFx.ts` owns the retype overlay's animation, kept out of the
  controller so the review flow never interleaves timing concerns with matching.
- `hook/` — standalone hook script installed into agent tooling (plain Node, no deps).
- `test/` — unit tests (`npm test`, Node's built-in runner). The hook script is tested
  end-to-end by spawning it as a subprocess with realistic payloads; installing and
  removing it are tested as pure transforms over a settings object, including the cases
  that must survive untouched — somebody else's hooks on the same event, or in the same
  entry.
- `test-integration/` — extension-host tests (`npm run test:integration`): boots a real
  editor against a fixture workspace and drives a full retype review, section skip,
  file skip, word fills, parking and resuming a review, a review that runs across two
  animation-level changes, and abort through the command layer.
- `scripts/seed-demo.js` — rebuilds `demo-workspace/` (gitignored, `npm run demo:seed`):
  a small workspace with pre-made baselines and pending debt, one file per interesting
  review case, so the review flow can be tried by hand without an agent session. The
  "Run Extension (Demo)" launch configuration seeds and opens it in one go.
- `.copyworkcode/` — per-workspace runtime data (event queue, baselines, review state).
  Never committed: enabling a workspace adds it to the repo-local exclude list
  (`.git/info/exclude`), which hides it from `git status` without editing the project's
  own `.gitignore` — a tracked file that belongs to everyone working on the repository.
