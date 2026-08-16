# copyworkcode

*(working name)*

A VSCode extension that turns AI-generated code changes into something you actively
review — by typing them yourself.

When an AI assistant edits your code, the change doesn't just land silently. Instead,
copyworkcode presents it and asks you to write it out, change by change. You can skip any
change with a click, and configure rules to auto-skip files you don't care to review
(lockfiles, generated code, formatting-only edits).

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

Early development. Not yet functional.
