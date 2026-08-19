# Design decisions

Working record of the architecture. Short on ceremony, long on "why".

## The core loop

AI-made code changes are captured as **change events**. Review debt, however, is not the
event queue itself: debt is defined **per file, as the net diff between the last-reviewed
baseline snapshot and the current content** (see "Unit of review" below). Changes apply to
files immediately — nothing blocks the AI's own build/test iteration. The user clears debt
by **retyping** the net change in a guided review flow — in a normal editable editor, so
rewriting the code instead of reproducing it is a first-class outcome — or by skipping it
(manually, or automatically via configurable file-pattern rules — lockfiles, generated
code, etc.).

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

The review opens the actual file in a **normal, editable editor** — not a diff view, not a
locked buffer — and guides retyping in place. An earlier version used the diff editor as the
review surface and was rejected after real use: the global red/green diff painting drowned
out every cue the review added, so reviewing felt indistinguishable from reading a diff. The
review now owns its visuals, and the baseline diff is one action away (an editor-title button
and a lens action open it side by side) instead of being the surface. Built on real text
editors with decorations (not a webview) so IntelliSense, navigation, and every language
feature keep working while reviewing.

What the reviewer sees: text still owed is dimmed; the section being worked on carries a
whole-line highlight, a left border, and a scrollbar mark; and the exact run the next
keystroke should produce is highlighted at the cursor. A lens strip floats above that section
with its progress ("Typed 34/120 · 6/9 claimed") and clickable fill-line (Alt+F), skip
(Alt+S), show-diff (Alt+D) and stop (Shift+Esc) actions. Every *other* section still owed
carries a one-click "start here" lens, because there is no order to fall back on any more —
the sections a reviewer hasn't reached have to be reachable from wherever they are. Every
control's hover says what it does and ends with its key, so the strip stays narrow and
nothing has to be memorized to be usable. A section the reviewer took over gets a marker of
its own, since guidance going quiet is otherwise indistinguishable from it being broken. The
status bar mirrors coverage and keybindings; clicking it — or Alt+J — snaps the viewport back
to the typing position after wandering off to read something else.

Typing has motion, because a surface that only dims and undims text reads as nothing
happening. An accepted keystroke flashes the run it produced and fades it in over about
120ms, so the character lands rather than simply appears; typing faster than that leaves a
short trail of settling characters behind the cursor. Text filled in rather than typed — a
word, a line, a whole section — gets the same treatment swept left to right, so a fill is
never mistakable for typing. A mismatch flares on the target it missed and decays over about
200ms, which reads as a rejection rather than the static red block it replaced.

Editor decorations compile to generated CSS rules: keyframes cannot be declared, and
transforms are ignored on inline text spans, so a character cannot be scaled or slid. Every
effect is therefore frame-stepped from the extension — a ladder of decoration types applied
to a range in turn, one frame per clock tick — and animates only properties that leave layout
alone: opacity, background, border, and weight (a monospace bold face carries the same
advance width, so the impact frame cannot reflow the line). Motion that displaces text was
considered and rejected: the one property that produces it, letter spacing, shifts the whole
rest of the line with it, and a surface being typed into cannot afford text that jumps under
the cursor. The clock runs only while something is in flight and the trail is bounded, so an
idle review costs nothing and a burst of fast typing cannot grow the repaint. Animation is
strictly decoration — it trails what the matching engine already decided and can never delay
or change what a keystroke does. `copyworkcode.animations` sets the level: `full`, `subtle`
(fades only, no flash), or `off`. Extensions get no reduced-motion signal from the editor, and
a surface that flashes on every keystroke needs an off switch that is not a guess about the
reader.

### Edit mode: the review guides, it does not lock

**The review happens in an editable buffer.** That is the shape of the whole feature: a
surface that refuses your keystrokes is a quiz, and the point was never a quiz. The buffer
already holds the final content (apply-now model), so:

- A keystroke that **matches** the target inserts nothing. It advances that section's
  position, and the dimming recedes behind it. Typing a change out is therefore
  non-destructive: a file reproduced exactly is left byte-identical, and a review cannot
  dirty, truncate, or lose it. This matters most for a file the agent created from scratch
  (empty baseline, so the whole file is one section): it reviews the same way, fully visible
  and dimmed until typed, rather than presenting as an alarming empty buffer.
- A keystroke that **doesn't match** is a real edit. It goes into the file, immediately,
  where the cursor is. Backspace, delete, paste, undo, multi-cursor, line moves — all of
  them are the editor simply doing its job. Backspace in particular needed no work at all:
  it was inert only because the buffer was locked.
- After `copyworkcode.freeEditAfter` **consecutive** unmatched characters (10 by default),
  the flow concludes the reviewer meant to write their own code here. It stops matching that
  section, stops the mismatch feedback, and records it as **edited** — a fourth outcome
  alongside typed, skipped and confirmed. Any matched keystroke resets the count to zero, and
  erasing never counts toward it: backspace is correcting, not diverging. The handover is
  scoped to that one section; guidance re-arms on the next.

Divergence being implicit was chosen over an explicit two-mode toggle. A toggle is honest but
demands a decision before you know whether you disagree with the code — and by the time you
do know, you are already typing. (The toggle stays the fallback if the implicit version proves
confusing in real use; see brainstorm.md.)

While a section is still being matched, a divergent character is written with an explicit
buffer edit rather than handed to the editor's own type handler. Two reasons. The edit
resolves only once the change has reached the extension, so the section has already been
re-anchored around the new character and no part of the flow has to race the change event.
And it inserts exactly the character typed, so an auto-closing pair cannot add a bracket the
target already has and leave the reviewer two characters from a target they were one character
from. Once a section is handed over, input takes the editor's normal path and every
convenience comes back with it — completions, auto-close, auto-indent, format-on-type.

Gestures run one at a time, in arrival order. Each of them reads a section's position, awaits
something, then writes it back, so two overlapping would decide from the same position and the
second would act on a stale offset. Whether the editor can really deliver a keystroke while the
previous one is still being answered is deliberately not depended on: commands driven from a
test arrive sequentially, so the suite cannot demonstrate the overlap, and the queue is cheap
enough to make the guarantee rather than assume it.

Keystrokes are still intercepted with a `type` command override. That is what guarantees
completions and snippets cannot type code on the reviewer's behalf *while a character is being
matched* — the one place where they would defeat the entire point. Enter and Tab are
dispatched as editor commands rather than `type` input, so both are rebound, scoped to the
moment a character is actually being matched: Enter routes through the engine so whitespace
snaps, and Tab fills the next word. Everywhere else, including inside a section that was
handed over, they are Enter and Tab.

The override is held only while the reviewed file is the active editor. It is a global
command — every keystroke in the window would otherwise take a round trip through the
extension just to be handed back to the editor — and a review outlives its tab, so it can be
the active editor for a small fraction of the time it exists.

`copyworkcode.lockDuringReview` (default off) brings the old behaviour back for anyone who
wants a review to reproduce a change strictly: the review editor is marked read-only for the
session, printable input still reaches the override (the editor dispatches `type` before its
read-only check), and every other gesture is inert. Mismatches insert nothing and no section
is ever handed over. It is an option, not the mechanism. Blocking by enumerating keybindings
was tried before it and rejected: that list can never be complete, and every miss aborted
somebody's review.

What edit mode gives up, deliberately: **stopping a review no longer leaves the file
untouched.** Whatever was typed or rewritten is already in it — that is what "lands in real
time" means. And completing a review advances the baseline to *the buffer's content*, which
is the reviewer's version rather than the agent's, so a section they rewrote is recorded as
reviewed and accepted instead of being handed straight back as debt.

### Offsets that survive the buffer changing

A section is a range of document offsets, and in an editable buffer those offsets move.
Earlier versions ended the review on any content change the flow had not made itself — a
formatter, an agent editing the file mid-review, a reload from disk — because the offsets were
invalid from that point on. That guard is precisely what forced read-only to exist.

It is replaced by remapping (`src/core/sections.ts`, pure and unit-tested, including a fuzz
pass over a few hundred arbitrary edits). Every change is reconciled against the section set:

- a change **before** a section shifts it;
- a change reaching into text **already typed** rewinds that section's claim to where the edit
  began — the characters after it are no longer the ones that were read and reproduced;
- a change in the **untyped remainder** re-slices the target, so a section's target always
  equals the document text it points at;
- a section **rewritten wholesale** keeps covering the replacement with nothing claimed: new
  text is unreviewed text;
- a section **edited away entirely** is closed out as edited;
- text inserted exactly **at** the typing position counts as covered, which is what makes a
  reviewer's own divergent character behave without a second pass to get wrong. The cost is
  that a formatter inserting at exactly the cursor is taken as covered too — the one offset
  where that is a fair guess, since it is where the reviewer is typing;
- overlaps left by a change straddling two sections are normalised away, so every character
  has exactly one owner.

None of this is announced. A file being written to repeatedly underneath a review would turn
any per-change notice into a stream of them, and the remapping is meant to be invisible. The
one exception is a change replacing the **whole document** — a revert or a reload from disk,
which says nothing about where the old text went and would otherwise collapse every section
onto one range. Those re-derive the sections from a fresh diff, and say so once, in the status
bar rather than in a dialog.

Changes landing outside every section are not turned into new sections. New debt shows up in
the queue the next time the file is read, which is the answer the debt model gives everywhere
else; growing the set live would mean treating the reviewer's own free editing as fresh debt
in the middle of their review.

### Sections are a set, not a sequence

Sections stopped being a walk. Each one carries its own typing position and its own outcome,
and the active one is whichever contains the cursor. Guidance is on only when the cursor sits
exactly where that section owes its next character, with no selection open; anywhere else the
reviewer is using the editor as an editor and their keystrokes are not second-guessed.

Ordered walking survives as the default *motion*, not as a rule: claiming a section walks the
cursor to the next one still owed, wrapping at the end, so someone who just keeps typing is
led straight through the file and never has to ask for the next section. Clicking anywhere
else hands the editor back on the spot. Progress reads as coverage — "6 of 9 claimed" — with
no notion of position in a queue.

A pure ordered walk was rejected once the lock was gone: with the cursor free, a flow that
insists on the next section spends its time fighting the user for it. What that gives up,
knowingly, is the sequence guarantee — coverage is measured, order is not.

Reaching full coverage *by typing* finishes the review on the spot. Reaching it because the
last section was handed over does not: the reviewer is mid-edit there, and saving the file and
clearing its debt out from under them would be the wrong moment. The finish is offered
instead — the status bar becomes the button, alongside a lens action, an editor-title button
and Alt+Enter.

**Parking went with the sequence.** One review is live at a time, and starting another file
ends the current one; per-section progress *is* the state, so there is no separate position
left to preserve. The read-only era parked a review and resumed it if the file was still
byte-identical, a check that under edit mode would almost never pass — the file changes
*because* it is being reviewed. A review does outlive its tab being closed (the document
usually does too, and an accidental close is not a decision to abandon a file) and ends when
the document itself closes, since its offsets describe a buffer that no longer exists.
Marking a file reviewed from the queue also ends its review, since the debt is being cleared
anyway. The start gate covers the whole async setup, so a doubled gesture — a double-click on
a row, an impatient re-click — still collapses into one review, and asking to review the file
already under review just jumps back to its typing position.

### Ambient change highlight

Independently of any review: the changed regions of **any** open file are marked against that
file's baseline — a light dim, a gutter icon and a scrollbar mark, with no session, no engine
and no lock (`copyworkcode.ambientHighlight`, on by default). This is the tool at rest, and it
serves a second use for it: an easier way to look at what changed recently, with no commitment
to review anything. On by default, because a feature that has to be switched on to be noticed
is not the tool at rest.

It keeps the review's polarity — changed code is the dimmed side, because that is what typing
over it undims — at a lighter dim than a review uses, so the two never read as the same state.
Full dim keeps its one meaning: under review, still owed. Inverting the ambient layer (dimming
the *unchanged* context so changes pop) reads better as a pure review surface and was rejected
for exactly that reason: it makes changed code the bright side, and the metaphor the product
runs on is that unreviewed code is dim until you give it life by typing it. The file under
review is excluded — its own overlay says more, and two dimming layers over one buffer
compound into a third shade that means nothing. Diffs are cached per document version and
coalesced to a pause in typing, and a file past a size cap is skipped.

### Fills: what the flow hands you, and what it advertises

Filling is not typing: a section cleared entirely by fills is recorded as skipped.

The right arrow is a control rather than navigation while a character is being matched:
there is nowhere useful to move right, since everything to the right is text still owed, so
the key spends itself on the word ahead — pending whitespace plus a run of identifier
characters, or a run of adjacent symbols so `=>` and `);` go in one press. Tab does the same
thing, which loses no indentation case: the word fill already consumes the whitespace before
the word, and indentation never has to be typed anyway (see the matching rules). Away from
the matching position both keys are an arrow key and a tab again, so a fill can never happen
where the reviewer isn't looking.

Neither the lens strip nor the status bar advertises the word fill any more. The controls a
review shows should be the ones worth teaching, and a gesture whose whole function is to hand
you a word you were supposed to type is not one to put in front of someone on every section.
It stays a keybinding and a palette command, so anyone who wants it — or wants it on a
different key — has it.

### The review queue view

One row per file waiting for review, in the extension's own activity-bar panel, biggest change
first — change size is what a reviewer picks by, so it leads the row: `+12 −3`, then the
review's coverage if one is live there, then how many agent edits are behind it, then the
directory. The file-icon theme keeps the icon, so a row still reads as the kind of file it is;
the colour of the change goes on the **filename** instead, through a file-decoration provider
using the standard git decoration colours by change shape (added, deleted, both). Inline
colour on the `+N −M` counts is not possible in a native tree view — a row's description is a
single uncoloured string — and rewriting the queue as a webview to get it was rejected, since
that costs the file-icon theme, the container badge and the welcome content. Decorations are
per-URI rather than per-view, so the same tint appears in the Explorer and on editor tabs: a
side effect rather than the goal, but a welcome one, since a file with unreviewed changes then
reads as one everywhere. The hover carries the long form — path, counts against whatever the
current baseline is, live coverage, agent edits, when it was last reviewed and how — the
container badge carries the pending count, and one inline button marks a file reviewed without
typing it. Alt+N moves to the next file in the queue, and finishing a review offers the same
move.

### Retype matching rules

Typing in a real buffer means the editor itself modifies text the user didn't type
(auto-indent, auto-closing brackets, format-on-type). The matching policy:

- **Code is typed character-for-character.** Editor completions and snippets are suppressed
  while a character is being matched — tab-completing whole lines would defeat the entire
  point.
- **Whitespace snaps to the target.** Any whitespace keystroke (space, enter, tab) at a
  formatting boundary auto-applies whatever whitespace the target text actually has — press
  space where the target has a newline and the newline is inserted for you, and vice versa.
  Typing the next visible character while whitespace is pending applies the run too, so
  indentation never has to be typed. Line endings and auto-indent artifacts can never cause a
  mismatch.
- **Trailing whitespace is absorbed.** When only whitespace remains in a section, the last
  accepted keystroke completes it — otherwise every section would end on an invisible pending
  newline the user has to guess at.
- **Multi-character input is not a match.** A paste, an IME commit, or a completion arriving
  as one `type` call cannot stand in for typing; it takes the divergence path like any other
  non-match, which in edit mode means it lands in the file as the edit it is.
- **Mismatches are edits, and enough of them end the matching.** This is what used to be
  tracked as a "strictness setting": the permissive mode is no longer a mode. Deliberate
  deviation is the default behaviour of a normal editor, and the divergence budget is the
  dial (`copyworkcode.freeEditAfter`). The strict end of it kept its own switch —
  `copyworkcode.lockDuringReview`, where a mismatch inserts nothing at all.
- Sections that only *removed* lines are explicit stops: nothing to retype, so the lens strip
  reports how many lines were deleted there and offers a one-click confirm, recorded
  separately from typed, skipped and edited counts.

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
  (diff, retype matching, the section model and its offset remapper, baseline store,
  event-log parsing, git baseline reads, agent settings transforms) so it can be
  unit-tested with plain Node. `src/core/sections.ts` is the one that has to be right for
  the review to survive an editable buffer, which is why it is pure. `src/typingFx.ts`
  owns the retype overlay's animation and `src/ambient.ts` the no-session change
  highlight, both kept out of the controller so the review flow never interleaves timing
  or whole-workspace concerns with matching.
- `hook/` — standalone hook script installed into agent tooling (plain Node, no deps).
- `test/` — unit tests (`npm test`, Node's built-in runner). The hook script is tested
  end-to-end by spawning it as a subprocess with realistic payloads; installing and
  removing it are tested as pure transforms over a settings object, including the cases
  that must survive untouched — somebody else's hooks on the same event, or in the same
  entry.
- `test-integration/` — extension-host tests (`npm run test:integration`): boots a real
  editor against a fixture workspace, one file per review case, and drives them through
  the command layer. Alongside the plain flow (typing, fills, skips, deletion confirm,
  abort, git mode, animation levels changing mid-review) it covers the cases that only
  exist because the buffer is editable: a mismatched keystroke landing in the file, ten in
  a row handing the section over, backspace, five foreign writes moving the sections
  underneath a live review, the buffer being replaced wholesale, claiming two sections out
  of order, and the read-only lock option.
- `scripts/seed-demo.js` — rebuilds `demo-workspace/` (gitignored, `npm run demo:seed`):
  a small workspace with pre-made baselines and pending debt, one file per interesting
  review case, so the review flow can be tried by hand without an agent session. The
  "Run Extension (Demo)" launch configuration seeds and opens it in one go.
- `.copyworkcode/` — per-workspace runtime data (event queue, baselines, review state).
  Never committed: enabling a workspace adds it to the repo-local exclude list
  (`.git/info/exclude`), which hides it from `git status` without editing the project's
  own `.gitignore` — a tracked file that belongs to everyone working on the repository.
