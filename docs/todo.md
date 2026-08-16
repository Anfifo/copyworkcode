# TODO

Working list, roughly in build order. Design rationale lives in [design.md](design.md).

## Next up

- [ ] **Guided retype experience** — the core of the product; needs a dedicated design
      pass before coding. Constraints already agreed: real editors + decorations (not a
      webview) so IntelliSense and navigation keep working; diff-style view; auto-jump to
      the next unreviewed section; skip-section and fill-next-line controls; free
      exploration of the rest of the file mid-review.
- [ ] **Intent extraction** — at review time, follow the recorded `transcriptPath` +
      `toolUseId` back to the assistant message that made the change and surface its
      stated reasoning next to the diff.
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
