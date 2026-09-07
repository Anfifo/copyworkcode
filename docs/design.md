# Design decisions

Working record of the architecture. Short on ceremony, long on "why".

## The core loop

AI-made code changes are captured as **change events**. Review debt, however, is not the
event queue itself: debt is defined **per file, as the net diff between the last-reviewed
baseline snapshot and the current content** (see "Unit of review" below). Changes apply to
files immediately — nothing blocks the AI's own build/test iteration. The user clears debt
by **retyping** the net change in a guided review flow — in a normal editable editor, so
rewriting the code is as first-class an outcome as reproducing it — or by skipping it
(manually, or automatically via configurable file-pattern rules — lockfiles, generated
code, etc.).

What this buys us, in order of priority:

1. **Actual review** — you can't skim what you have to type.
2. **Retention** — writing produces measurably better learning than reading.
3. **A measurable review signal** — typed vs. skipped is recorded per change.
4. **Intent alongside diff** — where the source tool exposes it, the AI's stated goal for
   a change is captured and shown next to it.

## Change detection

One capture path today: the agent hook below. A tool-agnostic fallback that infers agent
edits from editor and disk activity is planned but not built (see todo.md); until it
exists, changes that no hook saw are reached through the git comparison mode instead.

### Agent hook integration (precise, carries intent)

Tools that expose lifecycle hooks (Claude Code first) get a small hook script registered
for two moments around every file edit/write the agent performs:

- **Before the tool runs**, the hook snapshots the file's current content into the
  workspace's `baselines/` folder under the data home — but only if no baseline exists
  yet. This preserves the pre-change state the review diff needs, even when the editor is
  closed, and never overwrites a baseline (that would erase unreviewed debt).
- **After the tool runs**, the hook appends a JSON change event to the workspace's
  `events.jsonl` there.

Key properties:

- **Works regardless of where the agent runs.** The hook runs inside the agent's process
  — external terminal, integrated terminal, another window. Events land in the workspace's
  data folder under the user's home; the extension picks them up live via a file watcher,
  or catches up on next activation if the editor was closed during the session.
- **Intent is recoverable.** The hook records the session transcript path and tool-use id,
  so the extension can later extract the assistant's stated reasoning for that specific
  change and show it during review. Only the pointer is stored; the transcript remains the
  agent's own file, read on demand if a review asks for it.
- **Credentials are never copied.** Capture duplicates content by design — a baseline holds
  the pre-change version of a file and the event log holds the text of each edit — so a
  credentials file would end up written down twice over, inside a folder in the user's
  home that nobody browses. Files matching the exclusion list get neither: no
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
  only, and the hook is reconciled against it on activation and on every
  change. A machine that receives the preference through settings sync installs the hook
  itself, and the reconcile is idempotent in both directions — with capture off, the
  default, it returns without opening the settings file at all.
- **The settings file is never left half-written.** It belongs to the user and holds far
  more than this hook, so edits are surgical (entries are matched by script name, since the
  extension's install path moves with every update, and anything sharing an event or an
  entry is preserved) and the write goes to a temporary file renamed over the target, which
  is atomic within a directory. A failed write leaves the original intact.
- **It records only where invited.** The hook script no-ops in workspaces that haven't
  enabled the extension, so one user-wide entry never means recording everywhere. It finds
  the workspace by walking up from the agent's working directory to the nearest registered
  folder, so a session started in a subfolder still lands in the right store.
- **One implementation of the shared rules.** The hook ships next to the extension's
  compiled core and requires it for where the data lives, how baselines are named and which
  files are sensitive. Earlier versions carried copies of those in the script, each marked
  "keep in sync"; a hash in the path layout was the point at which a third copy would have
  been one too many.

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

- One snapshot file per source file in the workspace's `baselines/` folder (see "Where the
  data lives"), named by the percent-encoded workspace-relative path (forward slashes).
  Flat, greppable, no index to corrupt. The hook requires the compiled module that defines
  this naming, so it exists once.
- The *initial* baseline for a file is written by the capture hook just before the
  agent's first edit (see "Agent hook integration"). A brand-new file gets an empty
  baseline, so its whole content is debt. Files without a baseline have no debt — the
  extension only ever asks for review of changes it saw an agent make.
- The baseline advances when a review completes, when the user skips a file, or when an
  auto-skip glob matches a change event.
- Diffing is line-based, and line endings are normalized first: a CRLF/LF difference is
  never review debt.

Consequences:

- Agent iteration collapses to one review of the final result, not N intermediate states.
- Events annotate the diff, which stands on its own; a region with no event behind it can
  still show up (e.g. the user's own edits) and is simply not flagged as agent-made. The
  event model carries a source field so a second capture path can feed it without
  changing anything downstream.
- Baselines must be git-aware eventually (branch switches change files without anyone
  "editing" them); v1 may accept weirdness there, but it's a known hole.
  The git comparison mode below is not that fix, though it is a way out when snapshots
  have gone wrong: it ignores them entirely.

### Where the data lives

Everything the extension keeps — baselines, the event log, the review log — lives under
`~/.copyworkcode/workspaces/<key>/`, one folder per workspace, and nowhere inside the
workspace itself. `COPYWORKCODE_HOME` relocates the whole tree; the tests use it to keep
their data apart from the real one.

- **Out of the project, out of its git.** An earlier version kept the data in a
  `.copyworkcode/` folder at the workspace root and hid it by appending a line to
  `.git/info/exclude`. That put snapshots of the user's files next to those files and made
  the extension write into a repository it doesn't own, however local the file. Neither is
  necessary, so the extension now writes nothing into the project and nothing into `.git`;
  git is used read-only, for the comparison mode.
- **The user's home rather than the editor's storage.** Extensions normally keep files in
  the per-extension folder the editor hands them. That folder is not an option here: the
  capture hook is a bare Node process with no editor API, and the editor may not even be
  running when it fires. The home folder is also shared across editors, so two of them on
  the same machine see the same review state, where per-editor storage would split it.
- **Keyed by path, labelled by path.** The folder name is a hash of the workspace's
  canonical path — resolved, real, trailing separator stripped, forward slashes,
  case-folded where the filesystem is — so that every spelling of one folder, from the
  editor or from an agent's `cwd`, lands on one store. `workspace.json` inside carries the
  path in clear, so the folders can be read by a person. A workspace that moves gets a
  fresh store; the manifest is what would let a later version offer to adopt the old one.
- **Registered means enabled.** Enabling a workspace creates its folder and manifest;
  that folder's existence is the whole of "enabled", for the extension and the hook alike.
  Deleting review data for a workspace, from the palette and behind a confirmation, removes
  the folder and stops tracking. It is the one destructive command, and the only cleanup
  that exists: nothing prunes the event log or the review log on its own yet.

### Comparing against git instead

Snapshots only exist for changes something was watching. Work that landed while the
extension was off — or before it was installed — has no snapshot and therefore no debt,
so the queue reads "all clear" when there is plenty to review. The queue's header
therefore has a second mode: it switches the compared-against side from the last-reviewed
snapshot to the working tree's diff against a git revision (`HEAD` by default,
`copyworkcode.gitRef` for anything else). Everything downstream is untouched — same
sections, same retype flow, same on-demand diff — only the left-hand side differs.

It is an override, and a reversible one:

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

Git runs as a child process, so the only dependency is git being on `PATH`. A folder with no
repository, or a revision that doesn't exist, refuses the switch, since an empty queue would
read as "all clear".

## Enforcement model: apply-now, retype-to-clear

Chosen over a blocking gate. A gate (AI writes to a shadow buffer, real file changes only
after retyping) gives a stronger guarantee but breaks agents that need to run and test
their own edits mid-task, which is most of them. Debt mode keeps the agent loop intact, and
"debt cleared" becomes the review metric.

## Review UI: the file itself, in a real editor

The review opens the actual file in a **real editor** and guides retyping in place. An
earlier version used the diff editor as the review surface and was rejected after real use:
the global red/green diff painting drowned out every cue the review added, so reviewing felt
indistinguishable from reading a diff. The review now owns its visuals, and the baseline diff
is one action away (an editor-title button and a lens action open it side by side). Built on
real text editors with decorations so IntelliSense, navigation, and every language feature
keep working while reviewing — which is what this surface is for, and what the second one
gives up in exchange for holding the whole change set at once (see *The change set page*).

What the reviewer sees: text still owed is dimmed; the section being worked on carries a
whole-line highlight, a left border, and a scrollbar mark; and the exact run the next
keystroke should produce is highlighted at the cursor. A lens strip floats above that section
with its progress ("Typed 34/120 · 6/9 claimed") and clickable write-here (Ctrl+E),
fill-line (Alt+F), skip (Alt+S), show-diff (Alt+D) and stop (Shift+Esc) actions. Writing
leads, because disagreeing with the code is the point of a review and the fills are
conveniences that don't need advertising. Every *other* section still owed
carries a one-click "start here" lens, because there is no order to fall back on any more —
the sections a reviewer hasn't reached have to be reachable from wherever they are. Every
control's hover says what it does and ends with its key, so the strip stays narrow and
nothing has to be memorized to be usable. A section the reviewer took over gets a marker of
its own, since guidance going quiet is otherwise indistinguishable from it being broken. The
status bar mirrors coverage and keybindings; clicking it — or Alt+J — snaps the viewport back
to the typing position after wandering off to read something else.

### Marking what was removed

A removal has no text left in the buffer to dim, so the surface that shows changed code by
colouring it could not show a deletion at all: a deletion-only change was legible solely as a
lens above it, and only once the reviewer reached it. It is now marked in the git
deleted-resource colour, in a language of its own:

- **A rule between the lines.** A deletion-only section is anchored
  at the line *after* the removal, so a whole-line background would colour the one line that
  demonstrably survived. "Something was removed here" is a fact about the boundary between two
  lines, and a one-pixel border is the only decoration that can say it without claiming
  anything about either line's content.
- **The count in the gutter, and in the lens above the line — never on the line itself.** The
  count first went in the right margin, where it read as a label on whatever code was sitting
  there: the one line the removal had not touched. There are exactly two places that are not
  part of a line's text. The gutter is one, and it carries the number as a drawn badge
  ("−3"), which doubles as the way to find an unreached removal while scrolling past. The
  space *above* the line is the other, and it is where the deleted lines physically were — so
  the lens strip that renders there says it in words, including on sections the reviewer
  hasn't reached yet. Neither can hold the lines themselves; those are a hover away (see
  *What was removed, on demand*).
- **A replacement keeps the badge and gives up the rule.** Its added lines are already dimmed,
  boxed and lensed, and a red rule across the top of all that was the loudest thing on the
  screen while saying the least — that lines went to make room is what its lens already says
  in words. The badge stays, because without a mark nobody would think to hover.
- **The mark clears when its section is claimed.** It marks work the review still owes.
  An earlier version kept it for the rest of the review, on the
  grounds that a confirmed deletion would otherwise leave no trace of what happened there —
  but that trace is the diff's job, and a rule outliving the thing it pointed at is a stain on
  a line the reviewer has no further business with. The hover goes quiet with it: a hover
  behind nothing visible is a feature only its author knows is there.

The geometry has one trap worth stating: hunk line numbers come from the diff, which does not
count a file's trailing newline as opening a line, while an editor does. A removal that ran off
the end of the file can only be recognised by comparing against the diff's count
(`countLines`), never the editor's — and once recognised, whether it is drawn above or below
depends on whether the file ends in a newline. If it does, the empty last line sits exactly
where the removed text was and the rule goes above it; if the file ends mid-line there is
nothing left to draw above, and the rule goes under the last surviving line. Decorations cannot
be read back out of an editor, so none of this can be unit-tested; the four cases are pinned
down in the extension-host suite instead, which is where a real `TextDocument` exists to be
wrong about. The hover behind the mark reads the same anchor, so the line it answers on and
the line the rule is drawn at cannot drift apart.

### What was removed, on demand

The mark provokes a question it cannot answer, and the answer has nowhere in the buffer to
live: the text is not there any more, and decoration content is a single unstyled run, so
several removed lines cannot be rendered beside the rule at all. They are shown outside the
text flow instead, in two steps.

**Hovering the marked line gives the lines back**, as a fenced block in the document's own
language, so removed code arrives syntax-highlighted. It is a hover *provider*, because a
decoration's own hover message appears where the decoration's range is, and
a removal's range is the empty end of a line — which, on a blank line, is nothing to aim at. A
provider answers for the whole line the removal was marked at, which is where a reader points
anyway, and it answers only inside the live review.

**The hover stops at twelve lines and hands the rest to a panel.** A command link opens the
removed lines as a document of their own, peeked inline over the line they used to occupy, so
they can be read against the code that replaced them without leaving it. Long removals are cut
off: a popup that swallows the file behind it is worse than one that says
how much it is not showing. The whole-file comparison is still Alt+D's job — this is the part
of it that belongs where the change happened.

That document is named after the review as well as the section it belongs to. The editor caches
a virtual document by its URI and never asks for its content again, and one file reviewed twice
can lose different lines at the same offset; without the review in the name, the second review
would be served the first one's text. The name keeps the file's extension, which is all a peek
has to go on when it decides how to colour what it shows.

True inline expansion — lines pushed apart, the old text sitting in place — remains out of
reach: the API for it is proposed only, so a published extension cannot use it, and neither
ghost text nor a decoration can hold several syntax-coloured lines. A hover and a panel are
what the surface can do without one.

Typing has motion, because a surface that only dims and undims text reads as nothing
happening. An accepted keystroke flashes the run it produced and fades it in over about
120ms, so the character lands; typing faster than that leaves a short trail of settling
characters behind the cursor. Filled-in text — a word, a line, a whole section — gets the
same treatment swept left to right, so a fill is never mistakable for typing. A mismatch
flares on the target it missed and decays over about 200ms, which reads as a rejection. The
static red block it replaced did not move at all.

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

### Two states: guidance armed, or the editor yours

**The review happens in a real buffer, and at any moment it is in one of two states.** The
buffer already holds the final content (apply-now model), so *armed* — where every review
starts — means:

- A keystroke that **matches** the target inserts nothing. It advances that section's
  position, and the dimming recedes behind it. Typing a change out is therefore
  non-destructive: a file reproduced exactly is left byte-identical, and a review cannot
  dirty, truncate, or lose it. This matters most for a file the agent created from scratch
  (empty baseline, so the whole file is one section): it reviews the same way, fully visible
  and dimmed until typed. An empty buffer would read as the file having been lost.
- A keystroke that **doesn't match** inserts nothing either. It flashes, and the status bar
  says which key hands the editor over. The change is reproduced to the letter, so a file
  cannot end up a character away from the target because a slip was read as an opinion.
- **Nothing else reaches the file at all.** The review editor carries the session read-only
  flag, so a paste, a backspace, an undo, a drag, a code action — and a programmatic edit
  from any other extension — is inert. Printable input still arrives, because the editor
  dispatches `type` before its read-only check, which is exactly the split a review wants:
  matched keystrokes work, every other route in does not. A file rewritten on *disk* does
  still get through, since that is not an editor edit at all, and the review absorbs it.

Writing your own code is a gesture you ask for: **Ctrl+E** (`copyworkcode.enableEditing`).

- The read-only flag lifts, guidance stands down, and the file is an ordinary editor with
  every convenience back — completions, auto-close, auto-indent, format-on-type, Tab, Enter,
  multi-cursor, paste. The `type` override is dropped outright, so nothing about typing is
  special while it lasts.
- Nothing about the review is given up. Every section keeps its position, what is still owed
  stays dimmed, and changes are reconciled by remapping exactly as they are the rest of the
  time. The status bar and the active section's mark change *colour*, because a surface that
  polices your keystrokes and one that doesn't must not look alike — but not shape: the
  active section keeps the same box in both states. Where the review is pointing is the same
  question either way, and an earlier version that answered it with a bare edge in one state
  and a box in the other read as the highlight failing to follow along.
- Ctrl+E again (`copyworkcode.resumeTyping`) arms guidance and puts the caret back at the
  typing position of the section that was active, so the rest of the change is typed out from
  where it left off. Both directions are one keystroke, and neither loses progress.
- Going back to typing **saves** whatever was written, on the way through. An armed review
  cannot dirty the buffer (a matched keystroke inserts nothing) and a session-read-only
  editor refuses a save, so without this the reviewer's own work would sit in a buffer they
  cannot write until the review ended. Saving at the transition keeps disk and buffer in step
  for as long as guidance holds the file, and format-on-save lands while it is still
  writable, where remapping treats it like any other outside edit.
- A section whose text changed while editing was enabled is recorded as **edited**, a
  fourth outcome alongside typed, skipped and confirmed. What
  matters after a review is not how much of the agent's text was reproduced, but whether the
  file still says what the agent wrote.

Ctrl+E on the change set page means the same thing by way of this: it starts a review here,
already in the second state, carrying what that page had covered (see below).

`copyworkcode.startEditing` (default off) opens every review in the second state, for
someone who mostly rewrites what the agent wrote: the file is theirs from the first keystroke
and Ctrl+E is what turns guidance on. It changes the input mode alone; the change is still
dimmed, and every section still has to be claimed (typed, filled, skipped or confirmed) before
the review can finish.

The key is bound only while a review's own editor has focus, so Quick Open keeps Ctrl+E
everywhere else (and Ctrl+P covers it there too). Like every gesture here it is a contributed
keybinding, so it can be rebound in the editor's keyboard shortcuts without the extension
needing a setting of its own.

**Why the toggle is explicit.** The first version inferred it: a mismatched keystroke was a
real edit that landed in the file, and after a run of them the flow concluded the reviewer
meant to write their own code there and handed that section over. The argument for inferring
was that a toggle demands a decision before you know whether you disagree with the code.
Living with it showed what that argument missed. Text still owed is *dimmed*, which makes the
exact next character harder to read than ordinary code, so wrong keys are not rare — and
every one of them changed the file. The common case for the mechanism turned out to be a
typo, not disagreement, and "type it again, properly" wasn't even available: the stray
character was already in the buffer, so the target had moved out from under the reviewer. A
surface where a slip quietly rewrites the thing you are reading cannot be trusted with the
file. So the inference is gone, the dimming is lighter than it was (0.55, up from 0.35,
with the next character outlined as well as filled), and taking the pen is a keystroke.

Two settings went with it. `copyworkcode.freeEditAfter`, the divergence budget, has nothing
left to count. `copyworkcode.lockDuringReview` asked whether the review editor should be
read-only for the session, and that is no longer a preference: it is read-only while guidance
is armed and writable while it isn't. Blocking input by enumerating keybindings was tried
before the read-only flag and rejected — that list can never be complete, and every miss
aborted somebody's review.

Gestures run one at a time, in arrival order. Each of them reads a section's position, awaits
something, then writes it back, so two overlapping would decide from the same position and the
second would act on a stale offset. Whether the editor can really deliver a keystroke while the
previous one is still being answered is deliberately not depended on: commands driven from a
test arrive sequentially, so the suite cannot demonstrate the overlap, and the queue is cheap
enough to make the guarantee explicit.

Keystrokes are intercepted with a `type` command override. That is what guarantees completions
and snippets cannot type code on the reviewer's behalf — the one place where they would defeat
the entire point. Enter and Tab are dispatched as editor commands that bypass `type`, so
both are rebound while guidance is armed at a matching position: Enter routes through the
engine so whitespace snaps, and Tab fills the next word. Everywhere else — including the whole
time editing is enabled — they are Enter and Tab.

The override is held only while guidance is armed and the reviewed file is the active editor.
It is a global command — every keystroke in the window would otherwise take a round trip
through the extension just to be handed back to the editor — and a review outlives its tab, so
it can be the active editor for a small fraction of the time it exists.

What this model gives up, deliberately: **stopping a review does not always leave the file
untouched.** A review with no editing in it leaves the file byte-identical, but anything
written with editing enabled is already in it — that is what "lands in real time" means. And
completing a review advances the baseline to *the buffer's content*, which may be the
reviewer's own version, so a section they rewrote is recorded as reviewed and accepted, the
rewrite settled with it.

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
- text inserted exactly **at** the typing position counts as covered, so writing at the
  caret with editing enabled does not turn around and ask the reviewer to type their own text
  back. The cost is that a formatter inserting at exactly the cursor is taken as covered too —
  the one offset where that is a fair guess, since it is where the reviewer is typing;
- overlaps left by a change straddling two sections are normalised away, so every character
  has exactly one owner.

None of this is announced. A file being written to repeatedly underneath a review would turn
any per-change notice into a stream of them, and the remapping is meant to be invisible. The
one exception is a change replacing the **whole document** — a revert or a reload from disk,
which says nothing about where the old text went and would otherwise collapse every section
onto one range. Those re-derive the sections from a fresh diff, and say so once, in the status
bar.

Changes landing outside every section are not turned into new sections. New debt shows up in
the queue the next time the file is read, which is the answer the debt model gives everywhere
else; growing the set live would mean treating the reviewer's own free editing as fresh debt
in the middle of their review.

### Sections are a set, not a sequence

Sections stopped being a walk. Each one carries its own typing position and its own outcome,
and the active one is whichever contains the cursor.

**Guidance covers the whole dimmed run a section still owes, wherever in it the caret sits;
the next character has a single offset.** The first version required the caret to be exactly
there, which broke
on the most ordinary gesture there is: clicking into the changed code and typing. The caret goes
where the click landed, guidance was therefore off, and the keystrokes went in *beside* the text
they were meant to reproduce, which stayed owed — the tool reading as though it refused to
let you write over the change. Inside the dimmed run, typing is matched wherever the caret is,
the keystroke applies at the typing position, and a click into that run puts the caret there so
a character never appears somewhere other than the caret that asked for it.

**A click anywhere in a section still owed is a click on the section** as a whole —
including into text already covered. The caret goes to the typing position and the next key is
matched, wherever in the section the click landed. The alternative, leaving the caret in
covered text with guidance off, produced the one thing a review must never do: keystrokes that
silently go nowhere. Nothing can be written there anyway — an armed editor refuses every route
in — so a caret parked in covered text is not a reviewer writing, it is a reviewer pointing at
the section they want to work on. The cost is that the caret cannot be moved *within* a
section while armed; reading elsewhere, and writing anywhere, are both a click or a Ctrl+E
away. A selection or a second cursor is a gesture about the file as a whole, wider than the
one character a section is waiting for, and is left alone either way.

**A keystroke outside every section goes to the nearest one still owed.** With guidance armed
the file is read-only, so a key pressed with the caret in context, or in a section already
claimed, has nowhere to land. Handed to the editor, it came back as the workbench's "cannot
edit in read-only editor" — a true statement about the buffer, from a surface that knows
nothing about the review, and the thing a reviewer met most often, since the caret drifts a
line off the change as easily as onto it. It read as a locked file when in fact the review was
waiting. The review answers instead: the caret moves to the typing position of the closest
section that still owes something (a deletion counts, and is answered with "Enter confirms"),
and the key is then judged there like any other — a match counts, a wrong key flashes and says
the caret was moved. Moving on a wrong key is deliberate: the gesture said "I want to type",
and where is the review's to answer even when the key is not. Enter is routed the same way,
so no printable key reaches the read-only check while the review's editor is armed. Backspace,
the reflex after a wrong key, is answered the same way: nothing was inserted, so there is
nothing to erase, and the status bar says so. What still reaches the read-only check is a paste
or a selection typed over, which are gestures about the file as a whole, and
Ctrl+E remains the answer for those.

Ordered walking survives as a default *motion*: claiming a section walks the
cursor to the next one still owed, wrapping at the end, so someone who just keeps typing is
led straight through the file and never has to ask for the next section. Clicking anywhere
else hands the editor back on the spot. Progress reads as coverage — "6 of 9 claimed" — with
no notion of position in a queue.

A pure ordered walk was rejected because the review does not own the caret: clicking
anywhere is free even with the buffer read-only, and a flow that insists on the next section
spends its time fighting the user for it. What that gives up,
knowingly, is the sequence guarantee — coverage is measured, order is not.

Reaching full coverage *by typing* finishes the review on the spot. Reaching it because the
last section's text was edited away does not: the reviewer is mid-edit there, and saving the
file and clearing its debt out from under them would be the wrong moment. The finish is offered
instead — the status bar becomes the button, alongside a lens action, an editor-title button
and Alt+Enter.

**Opening another file parks a review; it does not end it.** One review is *live* at a time,
which is what an editor can support — the session read-only flag, the `type` override and the
overlay all belong to one document — but the one being left behind keeps everything that
matters: its sections, each one's position, and the version of the file it is against. Opening
that file again picks the same review up where it stopped, caret included, and the queue row
says so ("paused 3/9", where a live one reads "reviewing 3/9").

A parked review holds nothing while it waits. Nothing is dimmed, nothing is locked, and the
file is an ordinary editor, because dimmed text nobody can type into is a lie, and a document
that refuses to be written to with nothing on screen explaining why is worse than one that
gave the review up. Buffer changes still reach it, though, so a formatter, an agent or the
reviewer's own writing moves a parked review's sections exactly as it moves a live one's —
which is what makes picking one up honest. Text written into a parked
file is not recorded as the reviewer taking a section over: nothing was guiding the file, so
that edit is indistinguishable from a formatter's, and the section it landed in still has to
be typed out before it closes.

An earlier version of parking resumed a review only if the file was still byte-identical, and
that check was dropped for answering the wrong question — it says nothing about how far the
review got, and any editing at all makes it fail. What replaced it is not a better check but
no check: per-section progress is remapped as the file moves, so there is nothing left to
verify when it is picked up. Two things end a parked review outright, and both are about
having nothing left to point at — its document closing, since its offsets
describe a buffer that no longer exists, and its baseline going away. A live review ends on
those terms and three more: the file marked reviewed from the queue, the change set page taking
it over, and the reviewer stopping it. Stopping (Shift+Esc) is now the only gesture that throws
review progress away on purpose, and it says as much.

A review outlives its *tab* being closed only as far as the document does — usually a moment
longer, since an accidental close is not a decision to abandon a file, but no further. The
start gate covers the whole async setup, so a doubled gesture — a double-click on a row, an
impatient re-click — still collapses into one review, and asking to review the file already
under review just jumps back to its typing position. Resetting a paused review is a way of
asking for it back with nothing claimed, so it is picked up first and then reset.

### Fills: what the flow hands you, and what it advertises

Filling is not typing: a section cleared entirely by fills is recorded as skipped.

The right arrow is a control while a character is being matched:
there is nowhere useful to move right, since everything to the right is text still owed, so
the key spends itself on the word ahead — pending whitespace plus a run of identifier
characters, or a run of adjacent symbols so `=>` and `);` go in one press. Tab does the same
thing, which loses no indentation case: the word fill already consumes the whitespace before
the word, and indentation never has to be typed anyway (see the matching rules). Moving to
the next line is a fill of its own: where the pending whitespace crosses a line break the
gesture stops there, short of the first word of a line the reviewer has
not read yet. Away from
the matching position both keys are an arrow key and a tab again, so a fill can never happen
where the reviewer isn't looking.

Neither the lens strip nor the status bar advertises either fill any more, word or line.
The controls a review shows should be the ones worth teaching, and a gesture whose
whole function is to hand you text you were supposed to type is not one to put in front of
someone on every section. Dropping the line fill also shortens a strip that had grown long
enough for its actions to run together at a glance. Both stay keybindings and palette
commands, so anyone who wants them — or wants them on different keys — has them.

### The review queue view

One row per file waiting for review, in the extension's own activity-bar panel, biggest change
first — change size is what a reviewer picks by, so it leads the row: `+12 −3`, then the
review's coverage if one is live there. The file-icon theme keeps the icon, so a row still
reads as the kind of file it is.

**The row says two things, and the tooltip says the rest.** Four facts in middle dots, the edit
count and the directory as well, overflow a panel usually docked narrow enough to elide the end
of them. A description is read at a glance across a column of rows; a fact you go looking for
belongs in the tooltip, which has the full relative path, the edit count and the line counts
spelled out. The directory comes back to the row in the one case where the filename does not
settle which file this is: two rows sharing a name, which is the same rule the workbench applies
to its own editor tabs. A file at the workspace root prints no directory at all; a `.` there
reads as a stray dot after the counts.

**Colour in the panel means one thing: this file is being reviewed right now.** The row under
review has its filename tinted (`list.warningForeground`, the workbench's own list yellow, so
it lands as the theme's own yellow); every other row keeps the default
foreground. An earlier version tinted *every* queued row by the shape of its change — green for
additions, red for deletions, blue for both — and it was the wrong axis to spend the panel's
one colour on. All three said exactly the same thing about review state ("not reviewed"), they
differed only on what the row already prints as `+N −M` an inch to the right, and green in
particular read as *done* when it meant the opposite. There is deliberately no "reviewed"
colour, because there is nothing to colour: a completed review advances the baseline, the file
stops differing from it, and the row leaves the queue on its own.

Inline colour on the `+N −M` counts is not possible in a native tree view — a row's description
is a single uncoloured string — and rewriting the queue as a webview to get it was rejected,
since that costs the file-icon theme, the container badge and the welcome content. Decorations
are per-URI, so the tint also appears in the Explorer and on editor tabs,
which now marks the file being worked on wherever it shows up. The cost of narrowing the tint
is that a *pending* file no longer stands out outside this panel; the panel and its badge are
the place that answers "what is waiting", and the counts still carry the change shape as text.

Starting a review fires its own event, separate from the one that fires when a review ends: the
queue has to redraw so the row picks up its tint and its `reviewing N/M` coverage, but no
baseline moved, so nothing that depends on baselines should be invalidated with it.

**A row names the surface holding it.** Coverage can come from either review surface, and the
row says which: `reviewing 3/9` for the editor review running now, `paused 3/9` for one the
reviewer stepped away from, `on the page 3/9` for the change set page. One vocabulary for all
three would be shorter and would be a lie of the expensive kind — it would send a reviewer to
the editor for a file the page holds, where they would find nothing and start a fresh review
over the top of the progress they were looking for. The tint does not follow the page. It marks
where the reviewer is *in the queue*, and the page is not somewhere the queue can point them:
it is already open in front of them with its own progress on every file at once.

Each surface reports coverage in its own terms and neither knows about the other; naming the one
to go back to is the row's business, so the two answers are merged where the surfaces are wired
together, outside both. The editor answers first, and not only for tidiness:
starting a review there takes the file off the page, so a file both could claim is the editor's
by the time the row asks. The page reports a file only once a gesture has made it that file's
surface — every file in the change set is *on* the page, and reporting all of them would put a
reading on every row that says nothing but "the page is open" — and it stops reporting one that
finished there, whose baseline moved when it closed: debt standing against that file again is a
new change the page has not read, and `9/9` would be a lie about it.

Page coverage is redrawn when a region closes, since re-reading the queue diffs every file
in it and a keystroke is too often for that. The first gesture on a file counts as a move too,
because it is what puts the row's reading there at all, and the page closing counts as one in
the other direction.

The hover carries the long form — path, counts against whatever the
current baseline is, live coverage, agent edits, when it was last reviewed and how — the
container badge carries the pending count, and one inline button marks a file reviewed without
typing it. Alt+N moves to the next file in the queue, and finishing a review offers the same
move.

**Reset current review** is the row's other action, and only a row with an editor review on it
— running or paused — has it: a file whose review hasn't started has no progress to clear, and a
file the page holds has no reset to run, since resetting puts the buffer back to the version
handed over for review and the page edits no buffer. It puts every section back to
unreviewed *and* the file back to the version that was handed over for review. Both halves are
needed for the gesture to mean anything. Typing writes nothing to the buffer, so clearing the
positions alone would leave the reviewer's own rewrites in the file and immediately re-derive
them as sections — a reset that hands back a different change from the one it was asked to
redo. Restoring the text is what makes the second pass the same pass. It is also the only
thing in the review that destroys work, so it is the only thing that asks first — and only
when there is something to lose: with nothing written by hand, clearing the positions is
exactly what was asked for, and a dialog in front of it would be a dialog in front of every
reset.

### The change set page

One page, one document: every file with pending debt, in queue order, every changed region in
it, and the surviving code around each region. It opens from the queue's title bar, and it is
read top to bottom and typed in place.

It exists because a change set has no reading order in an editor. Twelve files touched in one
agent session are twelve tabs and twelve reviews taken one at a time, with nothing anywhere
that says what the session as a whole did. Alt+N walks the queue, but a walk is not a
document: there is no scrolling back to the thing three files ago that this file's change
explains. The page is the surface for reading a change set; the editor stays the surface for
sitting inside one file.

**It is a review surface in its own right.** Typing on the page counts for exactly what typing
in an editor counts for — the same regions, the same per-region outcomes, the same record in
the review log, the same baseline advance. A page that could only show the change would be a
diff with extra steps.

That it can be a page at all follows from how the editor review works. A matched keystroke
there inserts nothing: the buffer already holds the final content and the review only walks a
position through it. So a surface with no buffer gives up nothing by having none — the page
applies no edit anywhere, and has no file to keep in step with.

Both surfaces build their regions with `buildSections`, so the page's *n*th region of a file is
the editor's *n*th region of it. What they do not share is offsets. The editor review holds a
position inside a live buffer and reconciles it against every edit that lands there; the page
reviews the file as it stood when the page was built. That is also why finishing a file here
advances its baseline to the content the page read, whatever is on disk by then — anything
that landed in between comes back as debt on the next pass, which is the truth about it.

**One surface owns a file at a time**, and whichever the reviewer asked for last wins: the
first gesture that *lands* on the page ends an editor review of that file, and starting an
editor review drops the progress the page had on it. A key the region does not owe is not one
of those gestures: it changes nothing on the page, so it ends nothing in the editor either. Only the colliding file is affected, never the rest of
the page. Because the handover is asynchronous, a gesture is worked out before it and applied
after it, and nothing is applied to a file the page does not own by then — otherwise the first
keystroke on a file an editor review claimed in that gap would land anyway, leaving both
surfaces holding progress on it. A gesture whose progress was given up and taken back in the
same gap is dropped for the same reason: the position it reached was reached from a state that
is gone. Both surfaces would otherwise finish the same file, and the second finish writes a
second record over a baseline that already moved. Progress lives in the extension, so the tab
can be hidden and brought back without losing it. Closing it is a
different thing and takes the progress with it, because unclaimed progress with no surface
showing it is progress nobody can reach. For the same reason the document is built once and
rebuilt only when asked for: a queue redrawing itself under the reviewer would move the text
they were part way through typing.

What the page can do that a buffer cannot, and what it cannot:

- **Removed lines are shown in place, in full.** In a buffer they have nowhere to live, so a
  hover holds twelve of them and a panel holds the rest. The page has the room, so a deletion
  is simply there, where it was, in the deleted-resource colour.
- **Context is bounded and expandable.** Three lines either side of each region, and the holes
  between them stand as a control saying how many lines it is holding. A change set can span
  thousands of lines nobody intends to read, and sending every one of them to open the page is
  a cost paid on every file for the sake of the few gaps anyone opens.
- **No language features.** No IntelliSense, no go-to-definition, no hover from a language
  server; the syntax colour below is a lexer's guess from the file's extension. That is the
  trade, and the reason the editor surface is not going anywhere:
  "open in editor" sits on every file heading and on the region being worked on, and starts no
  review of its own.

**Writing your own code goes to the editor, and takes your place with it.** The page types
the change as written and offers no other way to produce text, so the gesture the editor
review answers with Ctrl+E — the reviewer disagrees, and writes their own version — is
answered here by handing the file over: the same key, and the button beside the fills, start
an editor review of that file at that region with the editor already in the reviewer's hands.

It is delegation because a second implementation would be a worse version of something that
already exists. A rewrite on the page would need a write path in a
surface whose whole claim is that it has none, a text box with no indentation, no bracket
matching and no completions, and an answer for what a changed region does to the snapshot the
rest of the document is drawn from. The editor has the first two settled and does not have the
third problem at all: it reviews a live buffer and reconciles every edit that lands in it. And
an editor is where anyone would rather write code, which is the whole reason the page says "no
language features" out loud.

What crosses with the file is the progress. Both surfaces build their regions with
`buildSections`, so a seed is the page's states in region order, and the review that receives
it starts where the reviewer stopped — the regions they typed out here are
claimed there, in the same order, with the same outcomes. Positions are re-counted on the way:
the page holds them in normalized text and a buffer holds the file's own endings, so a CRLF
break is one character on one side and two on the other. A seed of the wrong *shape* is refused
whole, because a file that gained or lost a region since the page read it
has moved somewhere the page's positions do not describe, and half-placed progress is worse
than none.

The seed only applies where there is nothing better. A review of that file that already
exists — live, or parked from an earlier visit — is the surface that has been holding it, and
its positions account for every edit since; the page's copy is a reading of the file as it
stood when the page opened. So an existing review is resumed and merely handed over, and the
seed is kept for what it was built for: a file the page is the only surface with progress on.

A handover is a deliberate exit, distinct from the collision the ownership rule covers, and the
page treats it as one. The file stops being the page's — no gesture reaches it, and the queue
row reads from the editor review, which is now the surface with its progress — but its regions
stay drawn, with what was covered still shown as covered, because this is still the document
of the change set and the reader may still want to read it there. What the page will not do is
take it back on a keystroke: the reviewer asked for the editor, their own writing is already in
the file, and a stray key undoing that would be the surface contradicting the gesture it was
given. Reloading the page is how a file comes back, being a fresh read of everything.

The document the page draws is line-ending normalized, which the buffer review cannot be. A
matched keystroke in an editor has to leave the file's own endings alone; a page writes code
into text nodes, where a carriage return is a line break in its own right and one left in
would draw a phantom blank line under every row of a CRLF file. Nothing is lost by dropping
them, because endings are normalized before the diff runs: a bare CR is never part of a change
and never something the reviewer owes. The page therefore counts a CRLF line one character
shorter than the editor review does, which is only visible in the "typed *n*/*m*" reading and
costs nothing — the two surfaces already keep their own positions.

The page's colour language is the review's first: code still owed is dimmed and comes up to
full strength as it is typed, and lines the change removed are drawn in the deleted-resource
colour. Owed against covered is the distinction the whole surface exists to draw, and it is
carried by *opacity* — which is what lets syntax colour sit underneath it, since a dimmed run
is dim whatever colour it is. The page shipped uncoloured to find out whether that was enough
on its own; it was not. A wall of monochrome code reads as flat, so the page is syntax coloured
now, owed text included.

The highlighter (`media/highlight.js`) is coarse on purpose: five kinds of run — comment,
string, number, keyword, type — chosen from the file's extension, with no grammar per language
and no dependency to keep. What it must not get wrong is the *text*: a line's tokens
concatenate back to that line character for character, which is the invariant a page built on
retyping cannot do without, and it is the one thing the highlighter's tests pin down. A run
coloured wrongly is only coloured wrongly, and colour is not what the reviewer is reproducing.
Two rules keep the guessing quiet: a word straight after a dot is a member name even when it
spells a keyword (`map.set`, `x.type`), and the keyword union leaves out the words that are
also everyday names. A quote left unterminated costs its own line and no more;
only delimiters that genuinely span lines — template literals, triple quotes — carry over. A
block of lines beginning inside a comment is spotted by a closer arriving with no opener before
it, which is the common case for a region drawn in the middle of a doc comment.

Removed lines stay uncoloured: they keep the deleted-resource colour whole, because that colour
is the only thing on the page saying they are gone. Every colour comes from the theme — the
token classes take the ones the workbench gives its debug variables view, the one place it
already colours code-like values — because a page carrying its own palette is a page that looks
wrong in half the themes it opens in.

The page runs under a strict content policy: nothing loads but the extension's own stylesheet
and script, and the script runs only under the nonce minted for that load. Code goes into the
document as text and never as markup, so a file's contents cannot become part of the page's
structure. Files whose content must not be copied never reach it either — the payload is built
from the queue, which is where they are already refused.

Keys are the editor review's wherever the editor review has one. Tab fills a word, Alt+F a
line, Alt+S skips the region, Alt+J brings the caret back into view, Ctrl+E hands the file to
an editor review so the region can be written by hand, and Enter is a line break — or, on a
deletion, the acknowledgement, since there is nothing there to type. Backspace erases nothing
and says so, since a wrong key never lands. Every other key scrolls the page. Ctrl+E is a
contributed keybinding like the rest, scoped to the page's own panel so Quick Open keeps it
everywhere else, and it is a *question*: the page holds the caret, so the command asks which
region is being worked on and the page answers with it.

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
- **One gesture crosses one line break.** Snapping stops after the first newline and the
  indentation behind it, so a blank line costs two keystrokes — exactly what the text costs in
  an ordinary editor. Unbounded, the rule swallowed whole paragraph breaks: one Tab at the end
  of a line could apply two newlines, the next line's indent *and* its first word, landing the
  reviewer somewhere they had not looked yet. A flow whose whole point is that the change goes
  past you one piece at a time cannot have a key that skips pieces. A break is `\r?\n`,
  so a CRLF target is never split down the middle.
- **Trailing whitespace is absorbed.** When only whitespace remains in a section, the last
  accepted keystroke completes it — otherwise every section would end on an invisible pending
  newline the user has to guess at.
- **Typographic punctuation takes any punctuation key.** An em dash, an en dash, a curly
  quote, an ellipsis, an arrow: an assistant writes these freely, and a standard keyboard has
  no key for any of them. Demanding the exact code point turned a review into a hunt for an
  input method, and gained nothing, because a matched keystroke inserts nothing — the file
  keeps the character it had whichever key stood in for it. So any punctuation or symbol
  keystroke matches a punctuation or symbol character outside ASCII. Letters and digits are
  never stood in for, in any script, and ASCII punctuation still wants itself: `-` for `—` is
  the concession, `.` for `,` is a slip. A fixed table of lookalikes was the alternative, and
  was rejected for the same reason the strictness dial was: every glyph it missed would be a
  fresh wall, and the list is never complete.
- **Multi-character input is not a match.** A paste, an input-method commit, or a completion
  arriving as one `type` call cannot stand in for typing, so an armed review rejects it and
  inserts nothing. Pasting is available with editing enabled, where it is the editor's own
  paste and not a review gesture at all.
- **A mismatch inserts nothing.** It flashes, and stays a mismatch however many times it is
  repeated. A strictness setting, and later a divergence budget, were both rejected:
  strictness is not a dial, because writing your own code is a state you enter deliberately.
- Sections that only *removed* lines are explicit stops: nothing to retype, so the lens strip
  reports how many lines were deleted there and offers a one-click confirm, recorded
  separately from typed, skipped and edited counts. **Enter confirms one**, the same key that
  acknowledges a deletion on the change set page. A printable key aimed at one is answered by
  the review ("nothing to type here; Enter confirms") before it reaches the editor's read-only
  message. That matters most on a file whose *first* change is a deletion: sections are walked
  in file order, so the review opens on a section with nothing to type, and the first keystroke
  would otherwise meet the workbench's "cannot edit in read-only editor", a true statement about
  the buffer that says nothing about the one gesture the section wants. A review answers for its
  own sections.

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
- **Input methods that commit more than one character.** Matching is per character, so an
  input-method commit — or anything else arriving as a multi-character `type` call — cannot
  match a target, and an armed review inserts nothing for it. Composing text that way means
  enabling editing first. Typing from a Latin keyboard is unaffected, and making composition
  a first-class match is unsolved.
- **Core-loop validation.** The real product risk is retyping feeling like punishment.
  The retype loop should reach crappy-but-real as early as possible to test the
  hypothesis before any polish work.

## Repo layout

- `src/` — extension source (TypeScript). `src/core/` holds editor-independent logic
  (diff, retype matching, the section model and its offset remapper, baseline store,
  event-log parsing, git baseline reads, agent settings transforms) so it can be
  unit-tested with plain Node. `src/core/sections.ts` is the one that has to be right for
  the review to survive an editable buffer, which is why it is pure. `src/typingFx.ts`
  owns the retype overlay's animation, kept out of the controller so the review flow never
  interleaves timing concerns with matching. `src/removalMark.ts` owns the mark for removed
  lines, a module of its own because its geometry is the one part of the overlay with a right
  answer to be wrong about, and it is worth testing on its own.
  `src/changeSetPanel.ts` hosts the change set page: the webview, the files the document is
  built from, the baseline advance and the log record. The rules behind it are two core
  modules — `src/core/changeSet.ts` turns a file's regions into the serializable document the
  page draws, the one place where the offsets a review works in become the line numbers a
  reader reads by, and `src/core/changeSetReview.ts` holds what each region owes and what a
  gesture comes to, including which surface owns a file. Those are the parts with a right answer
  to be wrong about, and the panel is left thin enough to be read at a
  glance.
- `media/` — the change set page's own files: `changeset.html`, `changeset.css` and
  `changeset.js`, plus the activity-bar icon. The page's script holds no review logic; every
  gesture goes to the extension and the page redraws from the answer, so the matching rules
  have exactly one implementation. The script is tested from `test/`, not from the extension
  host: nothing can post a message into a webview or press a key inside one from there, so
  `test/helpers/pageDom.ts` gives the shipped file the four globals a webview hands it and a
  document of the shape its HTML provides. Structure and messages can be asserted that way;
  colour, spacing and geometry stay eye-only, and the helper models none of them on purpose so
  nothing can be claimed about them by accident.
- `hook/` — standalone hook script installed into agent tooling (plain Node, no deps).
- `test/` — unit tests (`npm test`, Node's built-in runner). The hook script is tested
  end-to-end by spawning it as a subprocess with realistic payloads; installing and
  removing it are tested as pure transforms over a settings object, including the cases
  that must survive untouched — somebody else's hooks on the same event, or in the same
  entry.
- `test-integration/` — extension-host tests (`npm run test:integration`): boots a real
  editor against a fixture workspace, one file per review case, and drives them through
  the command layer. Alongside the plain flow (typing, fills, skips, deletion confirm,
  abort, git mode, animation levels changing mid-review) it covers the line between an
  armed review and an editable one — a wrong key, a raw edit command and a backspace all
  bouncing off an armed editor, and all three landing once editing is enabled — and the
  cases that only exist because the buffer is real: a reload from disk, five foreign writes
  moving the sections underneath a live review, the buffer being replaced wholesale,
  claiming two sections out of order, resetting one partway through, and the read-only flag
  lifting when a review ends. It is also the only place the removal mark can be checked:
  decorations are write-only, so what the suite asserts is which line each boundary anchors
  to, which side of it the rule goes, and what the badge beside it reads, against real
  documents with and without a trailing newline. Whether a mark *clears* is asked of the
  hover, which is painted from the same list of still-owed removals and, unlike a
  decoration, can be read back.
- `scripts/seed-demo.js` — rebuilds `demo-workspace/` (gitignored, `npm run demo:seed`):
  a small workspace with pre-made baselines and pending debt, one file per interesting
  review case, so the review flow can be tried by hand without an agent session. The
  "Run Extension (Demo)" launch configuration seeds and opens it in one go.
- Runtime data (event queue, baselines, review state) is not in the repository at all: it
  lives under `~/.copyworkcode/`, one folder per workspace — see "Where the data lives".
  `src/core/dataHome.ts` owns that layout, and both the extension and the hook go through it.
