# copyworkcode

*(working name)*

A VSCode extension that turns AI-generated code changes into something you actively
review — by typing them yourself.

When an AI assistant edits your code, the change doesn't just land silently. Instead,
copyworkcode presents it and asks you to write it out, change by change. It happens in a
normal editor, not a locked one: if you disagree with what the AI wrote, type what you
wanted instead and it lands in the file. You can skip any change with a click, and
configure rules to auto-skip files you don't care to review (lockfiles, generated code,
formatting-only edits).

## Why

1. **Actual review.** You can't skim code you have to type. Retyping forces you to read
   every line at the pace of understanding, not the pace of scrolling.
2. **Learning by writing.** Writing things down measurably improves retention. Keep
   building your understanding of your own codebase even when much of the code is
   AI-generated.
3. **Proof of review.** "I looked at it" is not measurable. "I typed it" is — the
   extension records which changes were written out versus skipped.
4. **Intent alongside diff.** Where possible, the AI's stated goal for each change is
   captured and shown next to it, so you review the *why* together with the *what*.

## Status

Early development, but the core loop works end to end:

- **Capture, if you want it.** Agent capture is off until you turn it on. Switched on, it
  records edits made by Claude Code through its hooks — a snapshot of each file taken
  before the edit, plus a log of what changed — by adding one entry to
  `~/.claude/settings.json`. Switching it off removes that entry again.
- **Queue.** Files with unreviewed changes are listed in the extension's own activity-bar
  panel, biggest change first.
- **Review.** Opening one guides the retype in place: text you haven't typed yet is
  dimmed, the section you're on is highlighted, and the diff against the baseline stays one
  keystroke away. Keystrokes that match the code insert nothing — they just undim it — so
  typing a change out exactly leaves the file byte-identical.
- **Disagree by typing.** The editor stays a real editor. Anything that doesn't match the
  code is an ordinary edit and lands in the file as you type it; backspace, paste and undo
  all work. Ten characters of your own in a row and the tool concludes you meant to rewrite
  this bit: it stops matching that section, records it as yours rather than the AI's, and
  picks guidance back up on the next one. There's no mode to switch, and erasing never
  counts against you. If you'd rather it be strict, one setting makes the file read-only
  for the review instead.
- **Walk it in any order.** Sections aren't a queue — click into any of them and start
  typing. Finishing one still moves you to the next, so you can also just keep typing and
  be led through the file.
- **See what changed without reviewing anything.** Changed regions of any open file are
  marked against the baseline — a light dim, a gutter icon, a scrollbar mark — with no
  review started. It doubles as a quieter way to look at what an agent just did.
- **Skippable at every scale.** Fill the next word or the rest of a line, skip a section or
  a whole file, or set globs for files you never want to review. Filled text is never
  counted as typed.
- **Git as a baseline.** With nothing to set up, the queue can compare the working tree
  against a git revision instead of the last-reviewed snapshot — which is also how you
  review changes that landed before capture was on.

Everything runs locally: no account, no network calls, no data leaving the machine. The
one file outside the workspace it will ever touch is the agent's own settings, only if you
turn capture on, and turning capture off puts it back.

Intent capture, detection for agents other than Claude Code, and the polish list are still
ahead.
