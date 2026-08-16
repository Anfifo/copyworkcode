# TODO

Working list, roughly in build order — committed work only. Design rationale lives in
[design.md](design.md); uncommitted ideas live in [brainstorm.md](brainstorm.md) and get
promoted here when they're deemed worth building.

## Next up

- [ ] **Smoke-test the capture hook against a real agent session** — confirm the payload
      field names match what the hook script expects before building on top of it.
- [ ] **Baseline snapshot store** — per-file last-reviewed snapshots; debt becomes the
      diff between baseline and current content, with events as annotations on it (see
      design.md, "Unit of review"). Replaces the raw event queue as the review model and
      is a prerequisite for the retype UI.
- [ ] **Guided retype experience** — the core of the product; needs a dedicated design
      pass before coding. Constraints already agreed: real editors + decorations (not a
      webview) so IntelliSense and navigation keep working; diff-style view; auto-jump to
      the next unreviewed section; skip-section and fill-next-line controls; free
      exploration of the rest of the file mid-review; matching rules per design.md
      (character-for-character code, whitespace snaps to target, strictness setting).
- [ ] **Content-exclusion globs at the capture layer** — the hook must record only the
      occurrence (never the content) for matching files, so secrets are never duplicated
      into the event log.
- [ ] **Intent extraction** — follow the recorded `transcriptPath` + `toolUseId` back to
      the assistant message that made the change and surface its stated reasoning next to
      the diff. Extract eagerly, near capture time — transcripts get compacted or
      deleted.
- [ ] **Heuristic detection layer** — tool-agnostic fallback: large non-typed insertions
      in the editor (paste / programmatic apply) and external writes to disk become
      candidate events; exclude known noise (git branch switches, formatters).

## Later

- [ ] Manual edits during retype: allow deviating from the AI's text; when the result
      differs, notify that the agent's context is stale and offer a pastable re-sync
      prompt summarizing the user's edits.
- [ ] Auto-skip rules beyond globs: by change size and change kind (formatting-only).
- [ ] Review stats: typed vs. skipped ratios over time, per file area.
- [ ] Adapters for more agents beyond the first integration.
- [ ] Events view should also show reviewed/skipped history, not only pending items.
- [ ] Multi-root workspace support (currently first folder only).

## Before going public / Marketplace

- [ ] Decide the final name ("copyworkcode" is a working name).
- [ ] LICENSE file.
- [ ] `publisher`, icon, categories/keywords in the manifest.
- [ ] CHANGELOG.md.
- [ ] Review `.vscodeignore` so the package ships only `out/`, `hook/`, README,
      CHANGELOG, LICENSE, icon.
- [ ] Rewrite README for end users (install, enable, hook consent flow).
