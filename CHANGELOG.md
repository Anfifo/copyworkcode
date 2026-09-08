# Changelog

Notable changes to CopyWorkCode. Versions follow [semantic versioning](https://semver.org).

## [Unreleased]

### Housekeeping

- **Reset Everything**, in the panel's header menu, returns CopyWorkCode to a fresh install:
  the workspace's review data is deleted, the compare mode is forgotten, agent capture is
  turned off and its hook removed, and every setting goes back to its default in user and
  workspace settings. One confirmation lists all of it. Delete Review Data for this Workspace
  is unchanged and still keeps capture on.
- **Check Agent Hook Configuration**, next to it, shows whether the agent settings file
  exists, whether the hook is present and which install it points at, and whether that
  agrees with the capture setting. Its buttons turn capture on or off, repair a missing or
  stale hook, remove one left behind, or open the file.
- The unit tests no longer write fixture baselines into the real data home.

### Review

- **Shift+Esc pauses the review.** The editor is handed back and every section keeps its
  progress; opening the file from the queue picks the review up where it was. Stop Review,
  which discarded progress, is gone. Reset Current Review is the way to discard, and it asks
  first when something has been typed.
- **Ignore in Reviews**, on a queue row's context menu, keeps a file, its folder, or its
  extension out of every future queue. The rule is appended to `.copyworkcodeignore` at the
  workspace root, a gitignore-shaped file created by the first ignore; **Open Ignore File** in
  the header menu edits it by hand. Ignoring leaves baselines and the review log untouched.
- **Compare Against a Commit** picks an older revision for git mode from a list of recent
  commits, or takes one typed by hand. The empty git-mode welcome offers it, since a clean
  tree at `HEAD` is where it is wanted; the header menu has it too. The choice is remembered
  per workspace and the first entry of the picker goes back to the `gitRef` setting.

## [0.0.3]

### Storage

- **Review data has left the workspace.** Baselines, captured events and the review log now
  live under `~/.copyworkcode`, one folder per workspace, keyed by a hash of the workspace
  path and labelled with the path in clear. Nothing is written into the project or into its
  `.git` directory any more; the repo-local exclude entry earlier versions added is no longer
  needed and is no longer written. `COPYWORKCODE_HOME` relocates the whole tree.
- **Capture follows the agent into subfolders.** A session started below the workspace root
  records into that workspace's store.
- **Delete Review Data for this Workspace** removes everything kept for the open workspace,
  behind a confirmation.
- The capture hook reads the data layout and the sensitive-file rules from the extension's
  compiled core instead of carrying its own copies.

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
  editor over and back; anything written by hand is recorded as edited.
- Sections are a set, not a sequence. Click into any of them; finishing one leads to the next.
- Fills and skips at every scale: the next word (Tab), the rest of a line (Alt+F), a section
  (Alt+S), a whole file, and auto-skip globs. Filled text is never counted as typed.
- Deleted lines are marked where they were, with a hover and a panel. Enter acknowledges them.
- Moving to another file parks a review; coming back picks up where it stopped.
- The change set page: every changed region of every file as one syntax-coloured document,
  typed in place. Ctrl+E hands a file from the page to an editor review.
- A review queue in the activity bar, biggest change first, with the row under review tinted.
- Git as a baseline: switch the comparison from the last-reviewed snapshot to a git revision.
- Agent capture, off until turned on. Edits made by Claude Code are recorded through its hooks
  by one entry in `~/.claude/settings.json`, removed again when capture is turned off.
  Credentials, keys and environment files are never copied.
