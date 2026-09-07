# TODO

Working list, roughly in build order — committed work only. Design rationale lives in
[design.md](design.md); uncommitted ideas live in [brainstorm.md](brainstorm.md) and get
promoted here when they're deemed worth building.

## Next up

- [ ] **Dogfood the core loop on real work.** The retype flow is built and tested; whether
      retyping feels like review rather than punishment is only testable by living with it.
      Expect matching-rule and pacing tweaks. Questions to answer by use:
      - Does losing the ordered walk cost anything now that coverage is the only guarantee?
        The fallback is recorded in brainstorm.md.
      - Does an armed review's read-only editor still read as an obstruction, now that a
        keystroke outside a section and Backspace after a wrong key are answered by the
        review? Every other way of touching the file goes through Ctrl+E first.
      - The removal mark and its hover, by eye only, since decorations are write-only: does
        the drawn gutter badge stay legible across themes and font sizes, and does the hover
        fire on a marked line that is blank? Demo files: `trimmed.ts` (removals with nowhere
        obvious to go), `overhaul.ts` (added, replaced and deleted lines), `churn.ts` (four
        sections in eight lines, eight removed lines behind two added ones).
- [ ] **Dogfood the change set page.** The payload, the review state, the page script and the
      highlighter are unit-tested; what is left is what no test can see:
      - Does syntax colour read as an aid or as noise, and does dim-against-full still read
        through it? The colour is coarse on purpose; watch for a wrong guess landing somewhere
        conspicuous.
      - Are removals shown in full, in place, a relief or a wall? The page lifts the hover's
        twelve-line cap; `churn.ts` is the pile-up to read it against.
      - Is three lines of context enough to place a change, or do the gaps get opened every
        time?
      - Does typing on a page that scrolls as one document keep the caret where the eye is?
      - Does `on the page 3/9` earn its width in a narrow queue row?
      - The handover (Ctrl+E on a region): does the key arrive at all, given the binding is
        scoped by panel id and Quick Open may win? The strip control is the fallback, but a
        key that silently does the wrong thing is worse than none. Does the file left behind
        read as handed on rather than lost? Its regions stay drawn; an italic path and
        `being reviewed in the editor` in the heading are all that say so. Is reloading enough
        to get a file back, or is returning one without re-reading the change set a real want?
- [ ] **Per-project override for content exclusion** — the exclusion patterns are fixed;
      a project keeping secrets under a name the list doesn't cover has no way to add it,
      and no way to reclaim a source file the list catches by mistake.
- [ ] **Intent extraction** — follow the recorded `transcriptPath` + `toolUseId` back to
      the assistant message that made the change and surface its stated reasoning next to
      the diff. Extract eagerly, near capture time — transcripts get compacted or
      deleted.
- [ ] **Heuristic detection layer** — tool-agnostic fallback for assistants without hooks,
      a whole file pasted from a chat window, or external tools writing to disk. Large
      multi-line insertions in the editor that don't match keystroke-by-keystroke typing
      (paste / programmatic apply) and writes that land on disk outside the editor become
      candidate events, writing a baseline first if the file has none, exactly as the hook
      does. Known noise is excluded where detectable (git branch switches, formatters);
      anything ambiguous is shown as a candidate the user can dismiss. These events carry
      no intent — that is inherent to the layer. Open question before building: whether
      the false positives are worth it now that git comparison covers the "nothing was
      watching" case with no setup.

## Later

- [ ] **Stale-context re-sync prompt** — a review can now end with sections the reviewer
      rewrote, which means the agent's picture of the file is out of date. Offer a pastable
      summary of what they changed, built from the sections recorded as edited.
- [ ] Auto-skip rules beyond globs: by change size and change kind (formatting-only).
- [ ] Review stats: typed vs. skipped ratios over time, per file area.
- [ ] Adapters for more agents beyond the first integration.
- [ ] Events view should also show reviewed/skipped history, not only pending items.
- [ ] Sections as expandable rows under each file in the queue, so a click can open
      the review at one specific section instead of the nearest one. Mostly answered from
      two other directions now — the in-editor "start here" lens within an open file, and
      the change set page across every file at once — so what is left is whether the queue
      itself still wants it.
- [ ] Multi-root workspace support (currently first folder only).
