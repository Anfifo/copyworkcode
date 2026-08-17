# TODO

Working list, roughly in build order — committed work only. Design rationale lives in
[design.md](design.md); uncommitted ideas live in [brainstorm.md](brainstorm.md) and get
promoted here when they're deemed worth building.

## Next up

- [ ] **Dogfood the core loop on real work** — the retype flow is built and tested, but
      the product hypothesis (retyping feels like review, not punishment) is only
      testable by living with it. Expect matching-rule and pacing tweaks to fall out.
- [ ] **Strictness setting for retype matching** — the permissive mode from design.md:
      deliberate deviation stops counting as a mismatch and feeds the stale-context
      re-sync flow (see "Later"). Current behavior is strict-only.
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
