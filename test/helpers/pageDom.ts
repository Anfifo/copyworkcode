/**
 * Enough of a document to run the change set page's own script against.
 *
 * The page is the one part of the extension that cannot be reached from the
 * integration tests: nothing can post a message *into* a webview from the
 * extension host, and nothing can press a key inside one. So its scripts are
 * loaded here instead — the real files, not a copy of their logic — with the four
 * globals a webview hands them standing in for the browser.
 *
 * What this models is structure: elements, their classes, their text, their data
 * attributes, and the three events the page listens for. What it deliberately
 * does not model is layout, style or geometry, so nothing here can be used to
 * make a claim about how the page *looks*. Assertions belong on the messages the
 * page sends and the structure it writes; anything visual stays a thing to check
 * by eye.
 */

import * as fs from 'fs';
import * as path from 'path';

/** A selector this document understands: a tag, classes and data attributes. */
interface Selector {
  tag?: string;
  classes: string[];
  attributes: Array<{ name: string; value: string }>;
}

function parseSelector(selector: string): Selector {
  const out: Selector = { classes: [], attributes: [] };
  const pattern = /^[a-zA-Z][\w-]*|\.[\w-]+|\[([\w-]+)="([^"]*)"\]/;
  let rest = selector.trim();
  while (rest.length > 0) {
    const match = pattern.exec(rest);
    if (!match) throw new Error(`selector not understood: ${selector}`);
    if (match[0].startsWith('.')) out.classes.push(match[0].slice(1));
    else if (match[0].startsWith('[')) {
      out.attributes.push({ name: match[1], value: match[2] });
    } else out.tag = match[0];
    rest = rest.slice(match[0].length);
  }
  return out;
}

/** `data-from` is `dataset.from`, the way a browser maps it. */
function datasetKey(attribute: string): string {
  const name = attribute.replace(/^data-/, '');
  return name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

export class FakeElement {
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  parent?: FakeElement;
  className = '';
  type = '';
  /** Set on a text node; an element's own text is written through textContent. */
  private own = '';
  private listeners = new Map<string, Array<(event: unknown) => void>>();
  /** How often anything asked to bring this element into view. */
  scrolled = 0;
  /** What `getBoundingClientRect` answers, for the caret-following check. */
  box = { top: 200, bottom: 220 };

  constructor(readonly tag: string) {}

  get classList() {
    const classes = () => this.className.split(/\s+/).filter(Boolean);
    return {
      add: (name: string) => {
        if (!classes().includes(name)) {
          this.className = [...classes(), name].join(' ');
        }
      },
      remove: (name: string) => {
        this.className = classes()
          .filter((each) => each !== name)
          .join(' ');
      },
      contains: (name: string) => classes().includes(name),
      toggle: (name: string, on?: boolean) => {
        const want = on === undefined ? !classes().includes(name) : on;
        if (want) this.classList.add(name);
        else this.classList.remove(name);
      },
    };
  }

  get textContent(): string {
    return this.own + this.children.map((child) => child.textContent).join('');
  }

  set textContent(text: string) {
    this.children.length = 0;
    this.own = text;
  }

  appendChild(child: FakeElement): FakeElement {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  replaceWith(node: FakeElement): void {
    const siblings = this.parent?.children;
    if (!siblings) return;
    siblings.splice(siblings.indexOf(this), 1, node);
    node.parent = this.parent;
    this.parent = undefined;
  }

  matches(selector: string): boolean {
    const want = parseSelector(selector);
    if (want.tag && want.tag !== this.tag) return false;
    const mine = this.className.split(/\s+/).filter(Boolean);
    if (!want.classes.every((name) => mine.includes(name))) return false;
    return want.attributes.every(
      (attribute) => this.dataset[datasetKey(attribute.name)] === attribute.value
    );
  }

  closest(selector: string): FakeElement | null {
    let node: FakeElement | undefined = this;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parent;
    }
    return null;
  }

  querySelector(selector: string): FakeElement | null {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const deeper = child.querySelector(selector);
      if (deeper) return deeper;
    }
    return null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const found: FakeElement[] = [];
    for (const child of this.children) {
      if (child.matches(selector)) found.push(child);
      found.push(...child.querySelectorAll(selector));
    }
    return found;
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  dispatch(type: string, event: Record<string, unknown>): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event);
  }

  focus(): void {
    /* focus is not modelled: the page keeps keys on the document either way */
  }

  blur(): void {
    /* nor is blur */
  }

  scrollIntoView(): void {
    this.scrolled++;
  }

  getBoundingClientRect(): { top: number; bottom: number } {
    return this.box;
  }
}

/** A keystroke as the page reads one. */
export interface Keystroke {
  key: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  /** True for the AltGr many layouts reach a brace with, which arrives as
   * Ctrl+Alt and has to be told apart from both. */
  altGraph?: boolean;
}

export interface Page {
  /** Messages the page has sent the extension, oldest first. */
  sent: Array<Record<string, unknown>>;
  /** Deliver a message from the extension. */
  receive(message: unknown): void;
  /** Press a key, the way the document sees one. */
  press(stroke: Keystroke | string): { defaultPrevented: boolean };
  /** Click an element inside the document. */
  click(element: FakeElement): void;
  /** Click a page control outside the document, such as the reload button. */
  clickControl(id: string): void;
  /** Run whatever the page asked to happen later — the wrong-key flash. */
  runTimers(): void;
  byId(id: string): FakeElement;
  /** Every rendered file, in page order. */
  files(): FakeElement[];
  /** One file's rendered regions, in page order. */
  regions(file: FakeElement): FakeElement[];
  /** The document root the page draws into. */
  doc: FakeElement;
}

/** The text of one file from `media/`, for whichever test runs it. */
export function mediaSource(name: string): string {
  return fs.readFileSync(path.join(repoRoot(), 'media', name), 'utf8');
}

/** Repo root, found by walking up from the compiled test to the manifest. */
function repoRoot(): string {
  let dir = __dirname;
  while (!fs.existsSync(path.join(dir, 'package.json'))) {
    const up = path.dirname(dir);
    if (up === dir) throw new Error('no package.json above ' + __dirname);
    dir = up;
  }
  return dir;
}

/**
 * Load the page's scripts into a document of the shape its HTML provides, and
 * hand back the ways a test can talk to it.
 */
export function loadPage(): Page {
  const elements = new Map<string, FakeElement>();
  const make = (tag: string, id: string) => {
    const node = new FakeElement(tag);
    elements.set(id, node);
    return node;
  };
  // The elements changeset.html gives the script by id.
  const doc = make('main', 'doc');
  make('p', 'summary');
  make('span', 'status');
  make('button', 'reload');

  const document = {
    getElementById: (id: string) => elements.get(id) ?? null,
    createElement: (tag: string) => new FakeElement(tag),
    createTextNode: (text: string) => {
      const node = new FakeElement('#text');
      node.textContent = text;
      return node;
    },
    addEventListener: (type: string, handler: (event: unknown) => void) =>
      documentEvents.addEventListener(type, handler),
  };
  const documentEvents = new FakeElement('#document');

  const windowEvents = new FakeElement('#window');
  const win: Record<string, unknown> = {
    innerHeight: 800,
    addEventListener: (type: string, handler: (event: unknown) => void) =>
      windowEvents.addEventListener(type, handler),
  };

  const sent: Array<Record<string, unknown>> = [];
  const api = { postMessage: (message: Record<string, unknown>) => sent.push(message) };
  const timers: Array<() => void> = [];
  const later = (fn: () => void) => {
    timers.push(fn);
    return timers.length;
  };

  // The page is a script, not a module: run it with the globals a webview gives
  // it. The shipped file has to be the one that runs; a copy of its logic here
  // would be a test of the copy. The highlighter goes first and hangs itself off
  // `window`, which is how the page finds it in a browser too.
  const run = (source: string) =>
    new Function('document', 'window', 'acquireVsCodeApi', 'setTimeout', source)(
      document,
      win,
      () => api,
      later
    );
  run(mediaSource('highlight.js'));
  run(mediaSource('changeset.js'));

  const press = (stroke: Keystroke | string) => {
    const key = typeof stroke === 'string' ? { key: stroke } : stroke;
    let defaultPrevented = false;
    documentEvents.dispatch('keydown', {
      key: key.key,
      altKey: Boolean(key.altKey) || Boolean(key.altGraph),
      ctrlKey: Boolean(key.ctrlKey) || Boolean(key.altGraph),
      metaKey: Boolean(key.metaKey),
      getModifierState: (name: string) => name === 'AltGraph' && Boolean(key.altGraph),
      preventDefault: () => {
        defaultPrevented = true;
      },
    });
    return { defaultPrevented };
  };

  return {
    sent,
    doc,
    receive: (message: unknown) => windowEvents.dispatch('message', { data: message }),
    press,
    click: (element: FakeElement) => doc.dispatch('click', { target: element }),
    clickControl: (id: string) => {
      const node = elements.get(id);
      if (!node) throw new Error('no control called ' + id);
      node.dispatch('click', { target: node, currentTarget: node });
    },
    runTimers: () => {
      const due = timers.splice(0, timers.length);
      for (const fn of due) fn();
    },
    byId: (id: string) => {
      const node = elements.get(id);
      if (!node) throw new Error('no element called ' + id);
      return node;
    },
    files: () => doc.querySelectorAll('.file'),
    regions: (file: FakeElement) => file.querySelectorAll('.section'),
  };
}
