import * as vscode from 'vscode';

/**
 * The mark for lines a change removed.
 *
 * A removal leaves no text behind to colour, so it cannot be shown the way an
 * addition is. What it does leave is a boundary — the line that took its place
 * — so the mark is a rule *between* lines, a one-pixel border. A background
 * would claim the line it touches was deleted, when that line is precisely the
 * one that survived.
 *
 * Nothing lands on the line's own text. An earlier version put the count in the
 * right margin, which read as a label on whatever code was sitting there — the
 * one line the removal demonstrably did *not* touch. The count belongs either
 * above the line, where the lens strip renders and where the deleted lines
 * physically were, or beside it in the gutter, which is the column for facts
 * about a line. It goes in both: the lens says it in
 * words, the gutter carries the number for reading and for finding while
 * scrolling past. The lines themselves are one hover away, and the whole
 * removal one click further.
 *
 * Only a deletion gets the rule. A replacement's added lines are already
 * dimmed, boxed and lensed, and a red rule across the top of all that was the
 * loudest thing on screen while saying the least — that lines went to make room
 * is what its lens already says in words. It keeps the gutter badge, which is
 * how the hover behind it is discoverable at all.
 *
 * The mark clears when its section is claimed. It marks work the review still
 * owes: what happened to the file is what the diff is for, and a rule that
 * outlives the thing it was pointing at is just a stain on a line nobody has
 * any further business with.
 */

/** One removal to mark. */
export interface Removal {
  /** Line in the current document that the removal left its boundary at. */
  line: number;
  /** The lines that went, in baseline order. The mark says where and how many;
   * these are what the reader asks for next. */
  text: string[];
  /** The removal ran off the end of the file, so nothing follows it: the rule
   * belongs below `line`. */
  atEnd: boolean;
  /** Lines were added here in place of the ones that went. Those additions
   * carry the section's own marks, so this removal gets no rule of its own. */
  replaced: boolean;
}

/** Where a removal's mark lands: the line the rule is drawn at, and which side
 * of that line it goes on. Shared, so the mark and the hover explaining it can
 * never disagree about which line a removal belongs to. */
export function removalAnchor(
  document: vscode.TextDocument,
  removal: Removal
): { line: number; below: boolean } | undefined {
  if (removal.text.length === 0) return undefined;
  const last = document.lineCount - 1;
  // A file ending in a newline leaves an empty last line, sitting at exactly
  // the position text removed from the end used to occupy. Drawing above that
  // line puts the rule in the right place; only a file with no such line —
  // one that ends mid-line — has nothing left to draw above.
  const trailingBlank = last > 0 && document.lineAt(last).text.length === 0;
  return {
    line: Math.min(Math.max(removal.line, 0), last),
    // The rule marks the line that took the removal's place. Past the end of
    // the file there is no such line, and the boundary belongs under the last
    // one that survived instead.
    below: removal.atEnd && !trailingBlank,
  };
}

/** How many removed lines the hover shows before it stops and hands the rest to
 * the panel: enough for a deleted block to be read where it happened, few
 * enough that the popup cannot swallow the file behind it. */
const HOVER_LINES = 12;

/**
 * What went, on demand. The mark can only say *that* lines were removed — the
 * text itself has no place in the buffer to live, and decoration content is a
 * single unstyled run, so it cannot be rendered beside the rule.
 *
 * A hover can hold it: a fenced block in the document's own language, so the
 * removed code arrives syntax-highlighted. Long removals are cut off, and
 * `showAll` — a command link to the panel — is where the whole thing lives.
 */
export function removalHover(
  document: vscode.TextDocument,
  removal: Removal,
  showAll: vscode.Uri
): vscode.Hover | undefined {
  const anchor = removalAnchor(document, removal);
  if (!anchor) return undefined;
  const md = new vscode.MarkdownString();
  // A command link is inert unless the message says which commands it trusts,
  // so it is granted exactly the one it needs.
  md.isTrusted = { enabledCommands: [showAll.path] };
  md.appendMarkdown(`**${deletedLines(removal.text.length)}**\n\n`);
  md.appendCodeblock(
    removal.text.slice(0, HOVER_LINES).join('\n'),
    document.languageId
  );
  const rest = removal.text.length - HOVER_LINES;
  md.appendMarkdown(
    rest > 0
      ? `[Show all ${lineCount(removal.text.length)}](${showAll}) — ${rest} more not shown`
      : `[Open in a panel](${showAll})`
  );
  return new vscode.Hover(md, document.lineAt(anchor.line).range);
}

/** A gutter badge: the count, and the line it belongs beside. */
export interface RemovalBadge {
  /** What the icon reads — "−3". Also the key its decoration type is cached
   * under, since a gutter icon belongs to the type and not to the range. */
  label: string;
  range: vscode.Range;
}

/** One document's removals, sorted into the decoration each belongs to. */
export interface RemovalRanges {
  above: vscode.Range[];
  below: vscode.Range[];
  badges: RemovalBadge[];
}

/** The git deleted-resource red, as a literal. Themes name it for decorations,
 * but a gutter icon is an image and cannot ask for a theme colour. */
const DELETED_HEX = '#c74e39';
const DELETED = new vscode.ThemeColor('gitDecoration.deletedResourceForeground');

/**
 * The decoration types a removal needs, owned together so no call site can
 * clear one and leave the others painted.
 */
export class RemovalMarks implements vscode.Disposable {
  private above: vscode.TextEditorDecorationType;
  private below: vscode.TextEditorDecorationType;
  /** One type per distinct count, built the first time that count is seen. The
   * number is drawn into the icon, and the icon belongs to the type, so a
   * shared type could only ever show one number. */
  private badges = new Map<string, vscode.TextEditorDecorationType>();

  constructor() {
    const rule = (borderWidth: string) => ({
      isWholeLine: true,
      borderWidth,
      borderStyle: 'solid',
      borderColor: DELETED,
    });
    this.above = vscode.window.createTextEditorDecorationType(rule('1px 0 0 0'));
    this.below = vscode.window.createTextEditorDecorationType(rule('0 0 1px 0'));
  }

  /** Paint `ranges` in `editor`, or clear every type when it is undefined. */
  apply(editor: vscode.TextEditor, ranges?: RemovalRanges): void {
    editor.setDecorations(this.above, ranges?.above ?? []);
    editor.setDecorations(this.below, ranges?.below ?? []);
    const byLabel = new Map<string, vscode.Range[]>();
    for (const badge of ranges?.badges ?? []) {
      const at = byLabel.get(badge.label);
      if (at) at.push(badge.range);
      else byLabel.set(badge.label, [badge.range]);
    }
    for (const [label, at] of byLabel) {
      editor.setDecorations(this.badgeType(label), at);
    }
    // A count that was on screen a moment ago and isn't now still has a type
    // holding its ranges, and this is the only place that clears it.
    for (const [label, type] of this.badges) {
      if (!byLabel.has(label)) editor.setDecorations(type, []);
    }
  }

  private badgeType(label: string): vscode.TextEditorDecorationType {
    const existing = this.badges.get(label);
    if (existing) return existing;
    const type = vscode.window.createTextEditorDecorationType({
      gutterIconPath: badgeIcon(label),
      gutterIconSize: 'contain',
      overviewRulerColor: DELETED,
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });
    this.badges.set(label, type);
    return type;
  }

  dispose(): void {
    for (const editor of vscode.window.visibleTextEditors) this.apply(editor);
    this.above.dispose();
    this.below.dispose();
    for (const type of this.badges.values()) type.dispose();
    this.badges.clear();
  }
}

/** Turn removals into the ranges the decoration types take. */
export function removalRanges(
  document: vscode.TextDocument,
  removals: readonly Removal[]
): RemovalRanges {
  const out: RemovalRanges = { above: [], below: [], badges: [] };
  for (const removal of removals) {
    const anchor = removalAnchor(document, removal);
    if (!anchor) continue;
    // Every range is the empty end of a line: a whole-line border does not care
    // where on the line it is anchored, and a gutter icon cares only which line
    // it is on.
    const at = document.lineAt(anchor.line).range.end;
    const range = new vscode.Range(at, at);
    if (!removal.replaced) {
      (anchor.below ? out.below : out.above).push(range);
    }
    out.badges.push({ label: badgeLabel(removal.text.length), range });
  }
  return out;
}

/** What the gutter icon reads. Past two digits the exact number stops being
 * legible at gutter size, and the badge only has to say that a lot went; the
 * lens above the line still gives the count in words. */
export function badgeLabel(lines: number): string {
  return `−${lines > 99 ? '99+' : lines}`;
}

/** The badge as an image. Written out per count and handed over as a data URI,
 * because an icon carrying a number cannot be a file shipped with the
 * extension: there is one for every count a change can have. */
function badgeIcon(label: string): vscode.Uri {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">` +
    `<text x="8" y="11.5" text-anchor="middle" textLength="14"` +
    // The gutter is a fixed and narrow column, so the glyphs are squeezed to
    // the width available.
    ` lengthAdjust="spacingAndGlyphs" font-family="system-ui, sans-serif"` +
    ` font-size="10" font-weight="600" fill="${DELETED_HEX}">${label}</text>` +
    `</svg>`;
  return vscode.Uri.parse(
    `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
  );
}

/** "1 line" / "3 lines". Shared so the lens strip and the hover under it never
 * phrase the same count two different ways. */
export function lineCount(lines: number): string {
  return `${lines} line${lines === 1 ? '' : 's'}`;
}

/** "1 line deleted" / "3 lines deleted". */
export function deletedLines(lines: number): string {
  return `${lineCount(lines)} deleted`;
}
