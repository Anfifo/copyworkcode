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

Tools that expose lifecycle hooks (Claude Code first) get a small hook script that fires
after every file edit/write the agent performs. The hook appends a JSON line to
`.copyworkcode/events.jsonl` in the workspace. Key properties:

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

The review experience opens the actual file in a diff-style view, auto-jumps to the next
unreviewed section, and guides retyping in place — with skip-section and fill-next-line
controls. Built on real text editors with decorations (not a webview) so IntelliSense,
navigation, and every language feature keep working while reviewing. The user can freely
look around the rest of the file mid-review.

### Retype matching rules

Typing in a real buffer means the editor itself modifies text the user didn't type
(auto-indent, auto-closing brackets, format-on-type). The matching policy:

- **Code is typed character-for-character.** Editor completions and snippets are
  suppressed inside the review region — tab-completing whole lines would defeat the
  entire point.
- **Whitespace snaps to the target.** Any whitespace keystroke (space, enter, tab) at a
  formatting boundary auto-applies whatever whitespace the target text actually has —
  press space where the target has a newline and the newline is inserted for you, and
  vice versa. Line endings and auto-indent artifacts can never cause a mismatch.
- **Strictness is a setting.** A permissive mode lets the user deliberately deviate —
  reformat or improve as they type — which feeds the deviation flow below (stale-context
  notification + re-sync prompt) instead of counting as a mismatch.

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

- `src/` — extension source (TypeScript).
- `hook/` — standalone hook script installed into agent tooling (plain Node, no deps).
- `.copyworkcode/` — per-workspace runtime data (event queue, review state). Never
  committed; the extension offers to gitignore it when enabling a workspace.
