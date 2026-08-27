# copyworkcode

*(working name)*

A VSCode extension that turns AI-generated code changes into something you actively
review — by typing them yourself.

When an AI assistant edits your code, the change doesn't just land silently. Instead,
copyworkcode presents it and asks you to write it out, change by change. While you type, the
file follows the code to the letter — a wrong key changes nothing — and if you disagree with
what the AI wrote, one keystroke hands you the editor to write your own version instead. You
can skip any change with a click, and configure rules to auto-skip files you don't care to
review (lockfiles, generated code, formatting-only edits).

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
- **Disagree in one keystroke.** While you're typing a change the file is read-only, so a
  key that doesn't match inserts nothing and neither does a stray paste or backspace — a
  mistyped character can't quietly rewrite the code you're reading. Press Ctrl+E and it's an
  ordinary editor again: write, erase, paste and reformat, with completions and auto-close
  back. Press it again and typing picks up exactly where you left off. Anything you changed
  by hand is recorded as yours rather than the AI's — and one setting opens every review that
  way round, if writing is mostly what you do.
- **Walk it in any order.** Sections aren't a queue — click into any of them and start
  typing. Finishing one still moves you to the next, so you can also just keep typing and
  be led through the file. Opening another file pauses the review you were in rather than
  ending it: come back to that file and it picks up exactly where you stopped, even if the
  file changed while it waited.
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
