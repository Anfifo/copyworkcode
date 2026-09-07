# CopyWorkCode

Review AI-generated code changes by typing them yourself.

[![Visual Studio Marketplace](https://vsmarketplacebadges.dev/version/Anfifo.copyworkcode.svg?label=Marketplace)](https://marketplace.visualstudio.com/items?itemName=Anfifo.copyworkcode)
[![Open VSX](https://img.shields.io/open-vsx/v/Anfifo/copyworkcode?label=Open%20VSX)](https://open-vsx.org/extension/Anfifo/copyworkcode)

Install from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=Anfifo.copyworkcode), or from [Open VSX](https://open-vsx.org/extension/Anfifo/copyworkcode) for editors that
use that registry.

When an AI assistant edits your code, the change doesn't just land silently. CopyWorkCode
presents it and asks you to write it out, change by change. While you type, the file follows
the code to the letter — a wrong key changes nothing — and if you disagree with what the AI
wrote, one keystroke hands you the editor to write your own version instead. Skip any change
with a click, and set rules to auto-skip files you don't care to review.

Everything runs locally: no account, no network calls, no data leaving the machine.

## Why

1. **Actual review.** You can't skim code you have to type. Retyping forces you to read every
   line at the pace of understanding.
2. **Learning by writing.** Writing things down measurably improves retention. Keep building
   your understanding of your own codebase even when much of the code is AI-generated.
3. **Proof of review.** "I looked at it" is not measurable. "I typed it" is — the extension
   records which changes were written out versus skipped.

## Getting started

1. **Install** the extension.
2. **Open a project** and run **CopyWorkCode: Enable in this Workspace** from the command
   palette. The extension does nothing in a workspace until you ask it to.
3. **Choose where changes come from.** Either turn on agent capture (below), or point the
   queue at a git revision with **CopyWorkCode: Compare Against Git** — which needs no setup
   and is also how you review changes that landed before capture was on.
4. **Open the CopyWorkCode panel** in the activity bar. Files with unreviewed changes are
   listed there, biggest change first. Click one to start reviewing it.

### Turning on agent capture

Capture is off until you turn it on. **CopyWorkCode: Turn On Agent Capture** records edits
made by Claude Code through its hooks — a snapshot of each file taken before the edit, plus a
log of what changed.

It works by adding **one entry to `~/.claude/settings.json`**. That file is the only thing
outside your workspace the extension will ever touch, it is only touched if you turn capture
on, and **CopyWorkCode: Turn Off Agent Capture** puts it back as it was.

Files whose contents should not be copied — credentials, keys, environment files — are
refused before they reach any review surface.

## Reviewing

Opening a file from the queue guides the retype in place. Text you haven't typed yet is
dimmed, the section you're on is highlighted, and the diff against the baseline stays one
keystroke away.

Matched keystrokes insert nothing — they lift the dimming — so typing a change out exactly
leaves the file byte-identical.

### Two states

While **guidance is armed**, the editor is read-only for the session. A key that doesn't match
inserts nothing, and neither does a stray paste, a backspace, an undo, or another extension's
edit. A mistyped character can't quietly rewrite the code you're reading.

Typing with the caret outside a section moves it to the nearest one still owed and judges the
key there, and Backspace after a wrong key has nothing to take back, so the status bar says so.
Punctuation the AI writes that has no key on your keyboard
(em dashes, curly quotes, ellipses) is matched by any punctuation key; the file keeps its own
character.

**Ctrl+E** hands the editor over: write, erase, paste and reformat, with completions and
auto-close back. **Ctrl+E** again arms guidance and puts the caret back where the section left
off. Neither direction loses progress, and anything you changed by hand is recorded as yours.

### Keys

| Key | Does |
| --- | --- |
| *any character* | Type the next character of the section |
| *any punctuation* | Stand in for an em dash, a curly quote, or any typographic character |
| <kbd>Tab</kbd> or <kbd>&rarr;</kbd> | Fill the next word |
| <kbd>Alt</kbd>+<kbd>F</kbd> | Fill the rest of the line |
| <kbd>Alt</kbd>+<kbd>S</kbd> | Skip the section |
| <kbd>Enter</kbd> | Line break — or, on a deletion, acknowledge it |
| <kbd>Ctrl</kbd>+<kbd>E</kbd> | Hand the editor over, and back |
| <kbd>Alt</kbd>+<kbd>J</kbd> | Jump to where you were typing |
| <kbd>Alt</kbd>+<kbd>D</kbd> | Show the diff against the baseline |
| <kbd>Alt</kbd>+<kbd>N</kbd> | Review the next file in the queue |
| <kbd>Alt</kbd>+<kbd>Enter</kbd> | Finish the review |
| <kbd>Shift</kbd>+<kbd>Esc</kbd> | Stop the review, keeping the debt |

Every one of these is a normal keybinding and can be rebound in Keyboard Shortcuts.

### Walking a change your own way

Sections aren't a queue — click into any of them and start typing. Finishing one still moves
you to the next, so you can also just keep typing and be led through the file.

Opening another file **pauses** the review you were in. Come back to that file and it picks up
exactly where you stopped, even if the file changed while it waited.

Lines the change removed are marked where they were, with the text on hover and a panel for
the ones that don't fit. There is nothing to type on a deletion — <kbd>Enter</kbd>
acknowledges it.

## The change set page

**CopyWorkCode: Open the Change Set Page** puts every changed region of every waiting file into one
document, read top to bottom and typed in place — for the sitting where you want to see what
a whole session did, laid out end to end.

Removed lines appear in full where they were. Context is three lines either side, expandable.
The keys are the ones above. There are no language features on the page — no IntelliSense, no
go-to-definition — so "open in editor" sits on every file, and <kbd>Ctrl</kbd>+<kbd>E</kbd>
hands a file to a real editor review carrying whatever the page already covered.

## Settings

| Setting | Default | Does |
| --- | --- | --- |
| `copyworkcode.autoSkipGlobs` | lockfiles, `node_modules` | Globs whose files are marked reviewed without typing |
| `copyworkcode.agentCapture` | `false` | Whether the agent hook is installed |
| `copyworkcode.gitRef` | `HEAD` | The revision to compare against in git mode |
| `copyworkcode.startEditing` | `false` | Open every review with the editor already yours |
| `copyworkcode.animations` | `full` | Typing effects: `full`, `subtle` or `off` |

## Requirements

VS Code 1.90 or later. Agent capture needs Claude Code; every other way in — git comparison,
the queue, the review itself — works without it.

## Status

Early development. The review loop works end to end; intent capture and detection for agents
beyond Claude Code are still ahead.

## License

[MIT](LICENSE)
