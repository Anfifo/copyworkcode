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
      A third thing to look at, this one only checkable by eye: the removal mark and the
      hover behind it. The first pass answered the loudest questions — the count left the
      right margin for the gutter and the lens, the rule left replacements, and the whole
      mark now clears when its section is claimed — but decorations are write-only, so
      what is left is still eye-only. Two specifics. Whether a drawn gutter badge stays
      legible across themes and font sizes, since it is an image and cannot ask a theme
      for its colour. And whether the hover still fires when the marked line is blank, the
      one case where there is no text under the pointer. In the demo workspace,
      `trimmed.ts` holds the two removals with nowhere obvious to go, `overhaul.ts` the
      everyday mix of added, replaced and deleted lines, and `churn.ts` the pile-up: four
      sections in eight lines, one of them hiding eight removed lines behind two added
      ones.
- [ ] **Dogfood the change set page** — the payload, the review state behind it, the page's
      own script and the highlighter are all unit-tested now, so what is left is what no test
      can see. Whether the syntax colour reads as an aid or as noise now that it is there, and
      whether dim-against-full still reads as clearly *through* it — the colour is deliberately
      coarse, so the thing to watch for is a guess landing somewhere conspicuous. Whether a
      file's removals shown in full, in place, are a relief or a wall — the page lifts the
      hover's twelve-line cap on purpose, and `churn.ts` in the demo workspace is the pile-up
      to read it against. Whether three lines of context either side is enough to place a
      change, or whether the gaps get opened every time. And whether typing on a page that
      scrolls as one document keeps the caret where the eye is, since the page follows the
      caret rather than the other way round. Now that the queue answers for the page
      too, whether `on the page 3/9` earns its width in a narrow row, or whether the surface
      a file is being read on is obvious enough without the row saying it.
      Lastly the handover. Ctrl+E on a region takes the file to an editor review carrying what
      the page had covered, and three things about it are only answerable by use. Whether the
      key arrives at all: the page is a webview, so the binding is scoped by panel id rather
      than by editor focus, and nothing but pressing it says whether Quick Open still wins —
      the control on the region's strip is the answer either way, but a key that silently does
      the wrong thing is worse than no key. Whether the file left behind reads as handed on
      rather than lost — its regions stay drawn with their progress, and all that says
      otherwise is an italic path and `being reviewed in the editor` in the heading. And
      whether reloading is answer enough for getting a file back, or whether wanting one
      returned without re-reading the whole change set is a real want.
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
      the review at one specific section instead of the nearest one. Mostly answered from
      two other directions now — the in-editor "start here" lens within an open file, and
      the change set page across every file at once — so what is left is whether the queue
      itself still wants it.
- [ ] Multi-root workspace support (currently first folder only).

## Before going public / Marketplace

- [ ] **Register the publisher.** The manifest claims `Anfifo`; it has to exist on the
      Marketplace, and on Open VSX separately, before either will accept a publish.
