# CopyWorkCode

Review AI-generated code changes by typing them yourself.

[![Visual Studio Marketplace](https://vsmarketplacebadges.dev/version/Anfifo.copyworkcode.svg?label=Marketplace)](https://marketplace.visualstudio.com/items?itemName=Anfifo.copyworkcode)
[![Open VSX](https://img.shields.io/open-vsx/v/Anfifo/copyworkcode?label=Open%20VSX)](https://open-vsx.org/extension/Anfifo/copyworkcode)

Install from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=Anfifo.copyworkcode),
or from [Open VSX](https://open-vsx.org/extension/Anfifo/copyworkcode) for editors that use that
registry.

## What it does

An AI assistant edits a file. CopyWorkCode lists the change and asks you to type it out. The
file already holds the new code, so a matching key inserts nothing and only lifts the dimming,
and a wrong key inserts nothing either. If you disagree with a change, one key hands you the
editor and you write your own version. Any section can be skipped with a key and any file with
a click, and files you never want to review can be skipped by rule or ignored.

Everything runs locally. Snapshots and the review log live under `~/.copyworkcode` in your
home folder. Nothing is written inside your project, and nothing leaves your machine.

## Why type it

- You cannot skim code you have to type. Every line gets read.
- Writing something down helps you remember it. You keep understanding your own codebase as
  more of it is written by an assistant.
- The extension records which changes were typed and which were skipped, so a review leaves
  evidence behind.

## Getting started

1. Install the extension.
2. Open a project and run `CopyWorkCode: Enable in this Workspace` from the command palette.
   The extension does nothing in a workspace until you ask.
3. Choose where changes come from: agent capture, or a comparison against git. Both are
   described below.
4. Open the CopyWorkCode panel in the activity bar. Files with unreviewed changes are listed
   there, biggest change first. Click one to start.

### Agent capture

`CopyWorkCode: Turn On Agent Capture` records edits made by Claude Code through its hooks.
Each file is snapshotted before the edit, and the edit is logged.

Capture works by adding one entry to `~/.claude/settings.json`. It is the only file the
extension edits that it does not own, it is touched only when you turn capture on, and
`Turn Off Agent Capture` removes the entry again. `Check Agent Hook Configuration`, in the
panel's menu, shows the current state of that entry and can repair or remove it.

Files that hold credentials, keys or environment variables are never snapshotted or queued.

### Comparing against git

`CopyWorkCode: Compare Against Git` lists what differs between the working tree and `HEAD`.
It needs no setup and covers changes made before capture was on. If the working tree already
matches `HEAD`, `Compare Against a Commit` lets you pick an older commit and review everything
since it.

## Reviewing

Open a file from the queue. Text you have not typed yet is dimmed, the section you are on is
highlighted, and the diff is one key away.

While guidance is armed the editor is read-only. A wrong key, a paste, a backspace, an undo or
another extension's edit all insert nothing. Typing with the caret outside a section moves it
to the nearest section still owed. Punctuation with no key on your keyboard, such as em dashes
and curly quotes, is matched by any punctuation key, and the file keeps its own character.

Ctrl+E hands the editor over. Write, paste and reformat as usual, with completions back.
Ctrl+E again re-arms guidance and returns the caret to where the section left off. Nothing is
lost in either direction, and changes you wrote by hand are recorded as yours.

### Keys

| Key | Does |
| --- | --- |
| *any character* | Type the next character of the section |
| *any punctuation* | Stand in for an em dash, a curly quote, or any typographic character |
| <kbd>Tab</kbd> or <kbd>&rarr;</kbd> | Fill the next word |
| <kbd>Alt</kbd>+<kbd>F</kbd> | Fill the rest of the line |
| <kbd>Alt</kbd>+<kbd>S</kbd> | Skip the section |
| <kbd>Enter</kbd> | Line break, or acknowledge a deletion |
| <kbd>Ctrl</kbd>+<kbd>E</kbd> | Hand the editor over, and back |
| <kbd>Alt</kbd>+<kbd>J</kbd> | Jump to where you were typing |
| <kbd>Alt</kbd>+<kbd>D</kbd> | Show the diff against the baseline |
| <kbd>Alt</kbd>+<kbd>N</kbd> | Review the next file in the queue |
| <kbd>Alt</kbd>+<kbd>Enter</kbd> | Finish the review |
| <kbd>Shift</kbd>+<kbd>Esc</kbd> | Pause the review. The file is yours again and the progress waits in the queue |

All of these are ordinary keybindings and can be changed in Keyboard Shortcuts.

### Moving around

Sections can be typed in any order. Click into one and start typing. Finishing a section
moves you to the next, so you can also keep typing and be led through the file.

Opening another file pauses the review. Come back and it continues where you stopped, even if
the file changed in between.

Removed lines are marked where they were, with the text on hover and in a panel when there is
too much for a hover. There is nothing to type for a deletion. Enter acknowledges it.

## The change set page

`CopyWorkCode: Open the Change Set Page` puts every changed region of every waiting file into
one document, read top to bottom and typed in place. Use it to see what a whole session did.

Removed lines appear in full where they were. Three lines of context surround each change and
can be expanded. The keys are the same as in the editor. The page has no language features,
so each file has an "open in editor" link, and Ctrl+E hands a file to a real editor review
with the page's progress carried over.

## Skipping and ignoring

Right-click a file in the queue and choose `Ignore in Reviews` to keep it, its folder, or its
extension out of every future queue. The rule is appended to `.copyworkcodeignore` at the
workspace root, one pattern per line in the shape of a `.gitignore`. The file is created by
the first ignore, and `Open Ignore File` in the panel's menu opens it for editing.

`copyworkcode.autoSkipGlobs` does something different: captured changes to matching files are
marked reviewed without typing. Lock files and `node_modules` are skipped this way by default.

## Starting over

`Delete Review Data for this Workspace` removes everything kept for the open workspace and
leaves capture on. `Reset Everything`, in the panel's menu, also turns capture off, removes
the hook, and returns every setting to its default. What you see next is the same welcome a
first install shows.

## Settings

| Setting | Default | Does |
| --- | --- | --- |
| `copyworkcode.autoSkipGlobs` | lockfiles, `node_modules` | Captured changes to matching files are marked reviewed without typing |
| `copyworkcode.agentCapture` | `false` | Whether the agent hook is installed |
| `copyworkcode.gitRef` | `HEAD` | The revision git mode compares against, unless a commit was picked for the workspace |
| `copyworkcode.startEditing` | `false` | Open every review with the editor already yours |
| `copyworkcode.animations` | `full` | Typing effects: `full`, `subtle` or `off` |

## Requirements

VS Code 1.90 or later. Agent capture needs Claude Code. Git comparison and the review itself
work without it.

## Status

Early development. The review loop works end to end. Intent capture and support for agents
other than Claude Code are still ahead.

## Developing

Node 22 or later (see `.nvmrc`). Then:

```sh
npm ci
npm run compile          # or: npm run watch
npm test                 # unit tests
npm run test:integration # boots a VS Code instance and drives a real review
```

The `Run Extension` launch configuration opens a development host with the extension loaded.
`Run Extension (Demo)` does the same against a generated playground workspace.

The integration suite downloads VS Code into `.vscode-test/` on first run. On Windows, clone
into a short path; VS Code cannot start from a folder nested deep enough to push its own files
past the 260-character path limit.

## License

[MIT](LICENSE)
