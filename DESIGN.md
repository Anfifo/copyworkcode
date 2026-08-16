# Design decisions

Working record of the architecture. Short on ceremony, long on "why".

## The core loop

AI-made code changes are captured as **change events**. Each event lands in a per-workspace
queue of *unreviewed changes* (review debt). Changes apply to files immediately — nothing
blocks the AI's own build/test iteration. The user clears debt by **retyping** each change
in a guided review flow, or by skipping it (manually, or automatically via configurable
file-pattern rules — lockfiles, generated code, etc.).

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

## Roadmap (agreed, not yet designed)

- **Manual edits during retype.** Retyping shouldn't require byte-perfect copying — the
  user may improve or reformat as they type. When the typed result deviates from what the
  AI wrote, notify the user that the AI's context is now stale and offer a pastable prompt
  summarizing their edits, so they can re-sync the assistant.
- **Auto-skip rules** by glob, change size, and change kind (formatting-only).
- **Adapters for more agents** beyond the first integration.
- **Review stats** — typed/skipped ratios over time, per file area.

## Repo layout

- `src/` — extension source (TypeScript).
- `hook/` — standalone hook script installed into agent tooling (plain Node, no deps).
- `.copyworkcode/` — per-workspace runtime data (event queue, review state). Never
  committed; the extension offers to gitignore it when enabling a workspace.
