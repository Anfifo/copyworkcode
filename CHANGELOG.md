# Changelog

Notable changes to CopyWorkCode. Versions follow [semantic versioning](https://semver.org).

## [Unreleased]

## [0.0.2]

### Review

- **Typographic punctuation takes any punctuation key.** An em dash, a curly quote or an
  ellipsis is matched by `-`, `'` or `.`, or any other punctuation key, since no keyboard has
  a key for them. The file keeps its own character; only the match is lenient.
- **Typing outside a section moves the caret to the nearest one** instead of surfacing the
  editor's "cannot edit in read-only editor" message. The key is then judged there.
- **Backspace after a wrong key** is answered by the review, which has nothing to erase,
  instead of by the editor's read-only message.

### Fixed

- The checkmark on a queue row, and the row's right-click "Mark Reviewed Without Typing" and
  "Reset Current Review", did nothing. The commands were reading the row the wrong way.

## [0.0.1]

First release. The review loop works end to end; the README describes how it is used.

- Retype a change in a real editor. A matched keystroke inserts nothing and lifts the
  dimming, so typing a change out exactly leaves the file byte-identical.
- Guidance is armed by default, with the editor read-only for the session. Ctrl+E hands the
  editor over and back; anything written by hand is recorded as edited rather than typed.
- Sections are a set, not a sequence. Click into any of them; finishing one leads to the next.
- Fills and skips at every scale: the next word (Tab), the rest of a line (Alt+F), a section
  (Alt+S), a whole file, and auto-skip globs. Filled text is never counted as typed.
- Deleted lines are marked where they were, with a hover and a panel. Enter acknowledges them.
- Moving to another file parks a review; coming back picks up where it stopped.
- The change set page: every changed region of every file as one syntax-coloured document,
  typed in place. Ctrl+E hands a file from the page to an editor review.
- A review queue in the activity bar, biggest change first, with the row under review tinted.
- Git as a baseline: compare the working tree against a revision instead of the last-reviewed
  snapshot.
- Agent capture, off until turned on. Edits made by Claude Code are recorded through its hooks
  by one entry in `~/.claude/settings.json`, removed again when capture is turned off.
  Credentials, keys and environment files are never copied.
