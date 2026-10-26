# TODO

Working list, roughly in build order — committed work only. Design rationale lives in
[design.md](design.md); uncommitted ideas live in [brainstorm.md](brainstorm.md) and get
promoted here when they're deemed worth building.

## Next up

- [ ] **Dogfood the core loop on real work.** The retype flow is built and tested; whether
      retyping feels like review or like punishment is only testable by living with it.
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
        read as handed on, or as lost? Its regions stay drawn; an italic path and
        `being reviewed in the editor` in the heading are all that say so. Is reloading enough
        to get a file back, or is returning one without re-reading the change set a real want?
- [ ] **Dogfood command capture.** The hook records what a shell command wrote, found by
      modification time once the command returns; the mechanism is in design.md. What only
      use can settle:
      - Two seconds of slack before the command's start: enough for every filesystem in
        use, and narrow enough that a save in the editor during a long command is not
        attributed to the command.
      - Without git, a file a command stamped but left as it was is taken as new in full,
        since nothing is there to compare against. Whether that happens often enough to
        want a lighter answer, or whether every project that hits it has git anyway.
      - The walk's cost on the largest workspace in use. It is under 40 ms on the ones it
        was measured on.
- [ ] **Per-project override for content exclusion** — the exclusion patterns are fixed;
      a project keeping secrets under a name the list doesn't cover has no way to add it,
      and no way to reclaim a source file the list catches by mistake.
- [ ] **Intent extraction** — follow the recorded `transcriptPath` + `toolUseId` back to
      the assistant message that made the change and surface its stated reasoning next to
      the diff. Extract eagerly, near capture time — transcripts get compacted or
      deleted. The transcript's format is internal to the agent and changes between
      versions, so the reader has to fail soft. Flagged sections (below) carry their intent
      directly; this covers every edit the agent did not flag.
- [ ] **Agent-flagged sections** — a local MCP server shipped with the extension gives the
      agent one tool to call after it edits: flag a stretch of the change as must-type or
      worth typing, with a reason and the intent behind it. The anchor is a snippet of the
      edited text, resolved to a range when the call arrives and carried forward like any
      section's progress. Flags only add to a review. A flagged section is required and
      sorts first, and nothing the agent says can make a section optional: the author
      choosing what its reviewer reads is the over-trust the product exists to counter. An
      opt-in mode requires only the flagged sections and records the rest as skipped. Stats
      keep typed-flagged and typed-unflagged apart, so it shows over time whether the flags
      point at what mattered. The server's own instructions tell the agent to use the tool,
      so the user's agent instructions stay untouched. Open before building:
      - Where the server is registered. The user-scope MCP list lives in the agent's own
        config file, which the agent rewrites constantly; a plugin owns its config but takes
        the on/off switch out of the extension (see brainstorm.md).
      - Where a reason shows during review: the section's hover, the review strip, the
        change set page.
      - Whether an end-of-turn hook should hold the agent back when it edited files and
        flagged nothing. It makes flagging reliable and costs a model turn each time, so it
        would be off by default.
- [ ] **Heuristic detection layer** — tool-agnostic fallback for assistants without hooks,
      a whole file pasted from a chat window, or a program writing to disk outside any
      agent's shell. Large
      multi-line insertions in the editor that don't match keystroke-by-keystroke typing
      (paste / programmatic apply) and writes that land on disk outside the editor become
      candidate events, writing a baseline first if the file has none, exactly as the hook
      does. Known noise is excluded where detectable (git branch switches, formatters);
      anything ambiguous is shown as a candidate the user can dismiss. These events carry
      no intent — that is inherent to the layer. Open question before building: whether
      the false positives are worth it now that git comparison covers the "nothing was
      watching" case with no setup.

## Later

- [ ] **Stale-context re-sync** — a review can now end with sections the reviewer
      rewrote, which means the agent's picture of the file is out of date. The agent's hook
      for a submitted prompt can add context to that turn, so the capture hook could tell it
      which sections were rewritten since its last edit, built from the sections recorded as
      edited. A pastable summary covers agents without that hook.
- [ ] Auto-skip rules beyond globs: by change size and change kind (formatting-only).
- [ ] Review stats: typed vs. skipped ratios over time, per file area.
- [ ] Adapters for more agents beyond the first integration.
- [ ] Events view should also show reviewed/skipped history alongside pending items.
- [ ] Sections as expandable rows under each file in the queue, so a click can open
      the review at a chosen section, where today it opens at the nearest. Mostly answered from
      two other directions now — the in-editor "start here" lens within an open file, and
      the change set page across every file at once — so what is left is whether the queue
      itself still wants it.
- [ ] Multi-root workspace support (currently first folder only).
