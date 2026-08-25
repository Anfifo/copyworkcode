# TODO

Working list, roughly in build order — committed work only. Design rationale lives in
[design.md](design.md); uncommitted ideas live in [brainstorm.md](brainstorm.md) and get
promoted here when they're deemed worth building.

## Next up

- [ ] **Dogfood the core loop on real work** — the retype flow is built and tested, but
      the product hypothesis (retyping feels like review, not punishment) is only
      testable by living with it. Expect matching-rule and pacing tweaks to fall out.
      Two things to watch specifically. Whether losing the ordered walk costs anything real
      now that coverage is the only guarantee — the fallback for that one is recorded in
      brainstorm.md. And whether an armed review's read-only editor reads as protection or
      as an obstruction: the wrong-key case it exists for is fixed, but every other way of
      touching the file now goes through Ctrl+E first, and only use will say whether that
      is one keystroke too many.
- [ ] **Per-project override for content exclusion** — the exclusion patterns are fixed;
      a project keeping secrets under a name the list doesn't cover has no way to add it,
      and no way to reclaim a source file the list catches by mistake.
- [ ] **Intent extraction** — follow the recorded `transcriptPath` + `toolUseId` back to
      the assistant message that made the change and surface its stated reasoning next to
      the diff. Extract eagerly, near capture time — transcripts get compacted or
      deleted.
- [ ] **Heuristic detection layer** — tool-agnostic fallback: large non-typed insertions
      in the editor (paste / programmatic apply) and external writes to disk become
      candidate events; exclude known noise (git branch switches, formatters).

## Later

- [ ] **Stale-context re-sync prompt** — a review can now end with sections the reviewer
      rewrote, which means the agent's picture of the file is out of date. Offer a pastable
      summary of what they changed, built from the sections recorded as edited.
- [ ] Auto-skip rules beyond globs: by change size and change kind (formatting-only).
- [ ] Review stats: typed vs. skipped ratios over time, per file area.
- [ ] Adapters for more agents beyond the first integration.
- [ ] Events view should also show reviewed/skipped history, not only pending items.
- [ ] Sections as expandable rows under each file in the queue, so a click can open
      the review at one specific section instead of the nearest one. The in-editor "start
      here" lens covers this within an open file; the queue does not.
- [ ] Multi-root workspace support (currently first folder only).

## Before going public / Marketplace

- [ ] Decide the final name ("copyworkcode" is a working name).
- [ ] LICENSE file.
- [ ] `publisher`, icon, categories/keywords in the manifest.
- [ ] CHANGELOG.md.
- [ ] Review `.vscodeignore` so the package ships only `out/`, `hook/`, README,
      CHANGELOG, LICENSE, icon.
- [ ] Rewrite README for end users (install, enable, hook consent flow).
