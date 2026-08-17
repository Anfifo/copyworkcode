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
  change and show it during review.
- **Setup is automated.** The extension installs the hook config on the user's behalf
  (one consent prompt) — no manual settings editing. The hook script no-ops in workspaces
  that haven't enabled the extension, so it's safe to install user-wide.

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

## Enforcement model: apply-now, retype-to-clear

Chosen over a blocking gate. A gate (AI writes to a shadow buffer, real file changes only
after retyping) gives a stronger guarantee but breaks agents that need to run and test
their own edits mid-task, which is most of them. Debt mode keeps the agent loop intact and
makes the review metric "debt cleared" rather than "gate passed".

## Review UI: real editor, not a webview

The review experience opens the actual file in a diff view against its baseline,
auto-jumps to the next unreviewed section, and guides retyping in place — with
skip-section (Alt+S) and fill-next-line (Alt+F) controls, and Shift+Esc to stop. Built on
real text editors with decorations (not a webview) so IntelliSense, navigation, and every
language feature keep working while reviewing. The user can freely look around the rest
of the file mid-review.

How the in-place retype works, given that changes are already applied to the file
(apply-now model): the flow walks the changed sections top to bottom; the current
section's new text is removed from the buffer and the user types it back in, validated
keystroke by keystroke, with the upcoming text of the line shown as a ghost preview at
the cursor. Reproducing the section exactly means the file ends the review byte-identical
to where it started — the typing was the review. Sections that only *removed* lines have
nothing to retype; they are shown in the diff and confirmed with one click.

Keystrokes are intercepted with a `type` command override while a review is active. That
is what guarantees completions, snippets, and auto-closing pairs can never insert text on
the user's behalf inside the review region — rather than trying to disable each editor
convenience individually. Any buffer change that doesn't come from the review flow itself
(undo, a formatter, an agent editing the file mid-review) aborts the review and restores
the content; debt is left in place.

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

- **Secrets in the event log.** The hook copies file content into
  `.copyworkcode/events.jsonl`; an agent editing a credentials file duplicates secrets
  there. Content-exclusion globs must exist at the *capture* layer (record occurrence,
  never content), not just at the review layer.
- **Intent quality.** The transcript text preceding a tool call is often thin ("now let
  me fix the import"). Intent must be extracted eagerly (transcripts get compacted or
  deleted), and genuinely useful rationale may need users to nudge their agent's
  instructions to state goals before editing.
- **Core-loop validation.** The real product risk is retyping feeling like punishment.
  The retype loop should reach crappy-but-real as early as possible to test the
  hypothesis before any polish work.

## Repo layout

- `src/` — extension source (TypeScript). `src/core/` holds editor-independent logic
  (diff, retype matching, baseline store, event-log parsing) so it can be unit-tested
  with plain Node.
- `hook/` — standalone hook script installed into agent tooling (plain Node, no deps).
- `test/` — unit tests (`npm test`, Node's built-in runner). The hook script is tested
  end-to-end by spawning it as a subprocess with realistic payloads.
- `test-integration/` — extension-host tests (`npm run test:integration`): boots a real
  editor against a fixture workspace and drives a full retype review, section skip,
  file skip, and abort through the command layer.
- `.copyworkcode/` — per-workspace runtime data (event queue, baselines, review state).
  Never committed: enabling a workspace adds it to the repo-local exclude list
  (`.git/info/exclude`), which hides it from `git status` without touching the project's
  `.gitignore` or prompting anyone.
