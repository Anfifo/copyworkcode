# Changelog

Notable changes to CopyWorkCode. Versions follow [semantic versioning](https://semver.org).

## [Unreleased]

## [0.0.1]

First release. The review loop works end to end.

### Review

- **Retype a change in a real editor.** The buffer already holds the final code, so a
  keystroke that matches inserts nothing and only lifts the dimming behind it — typing a
  change out exactly leaves the file byte-identical.
- **Guidance is armed by default.** The editor is read-only for the session while it is, so
  a wrong key, a stray paste, a backspace or another extension's edit cannot reach the file.
- **Ctrl+E hands the editor over** with every convenience back: completions, auto-close,
  paste, format-on-type. Ctrl+E again arms guidance and puts the caret back where the
  section left off. Anything written by hand is recorded as edited rather than typed.
- **Sections are a set, not a sequence.** Each carries its own progress; click into any of
  them at any time. Finishing one still leads to the next.
- **Fills and skips at every scale**: the next word (Tab), the rest of a line (Alt+F), a
  section (Alt+S), a whole file, or globs that auto-skip files you never want to review.
  Filled text is never counted as typed.
- **Deleted lines are shown where they were** — a gutter mark, a hover, and a panel for the
  ones that do not fit. Enter acknowledges them; there is nothing to type.
- **Moving to another file parks a review** rather than ending it. Coming back picks up
  exactly where you stopped, even if the file changed while it waited.

### The change set page

- **Every changed region of every file, as one document**, read top to bottom and typed in
  place. Removed lines appear in full where they were; context is bounded and expandable.
- **Syntax coloured**, with owed-versus-covered carried by opacity so colour can sit under
  it rather than compete with it.
- **Ctrl+E hands a file to an editor review** carrying what the page already covered, for
  writing your own version of a region.

### Queue and baselines

- Files with unreviewed changes in a dedicated activity-bar panel, biggest change first.
- The row under review is tinted, in the panel and on its editor tab.
- **Git as a baseline**: compare the working tree against a git revision instead of the
  last-reviewed snapshot, which is also how to review changes that landed before capture
  was switched on.

### Capture

- **Off until you turn it on.** Switched on, edits made by Claude Code are recorded through
  its hooks — a snapshot taken before each edit plus a log of what changed — by adding one
  entry to `~/.claude/settings.json`. Switching it off removes that entry again.
- Files whose contents must not be copied (credentials, keys, environment files) are
  refused before they reach any review surface.

Everything runs locally: no account, no network calls, no data leaving the machine.
