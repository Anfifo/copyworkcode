#!/usr/bin/env node
'use strict';

// Rebuilds demo-workspace/ from scratch: a small workspace with pre-made
// baselines and pending review debt, one file per interesting review case.
// Because the data directory exists, the workspace counts as enabled — open
// it in an extension development host and the review tree is already
// populated, no agent session needed.
//
// Every file here is also a place to try both sides of a review: typing the
// change out to watch wrong keys bounce off, and pressing Ctrl+E to write a
// different version instead.
//
// Run directly with `npm run demo:seed`, or use the "Run Extension (Demo)"
// launch configuration, which seeds and opens it in one go. Re-running the
// script resets every file to its start state.

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'demo-workspace');
const baselines = path.join(root, '.copyworkcode', 'baselines');

reset(root);
fs.mkdirSync(baselines, { recursive: true });

// Clear the workspace out. An editor watching the folder — which it is, since
// the folder lives in the repo you are editing — can hold a handle on the
// directory itself for a moment, and removing it outright then fails with
// EBUSY. Emptying it is just as good a reset and does not need the directory to
// go away, so that is the fallback rather than an error the reseed dies on.
function reset(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  } catch (err) {
    if (err.code !== 'EBUSY' && err.code !== 'EPERM' && err.code !== 'ENOTEMPTY') {
      throw err;
    }
  }
  for (const entry of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

// Baseline naming convention shared with src/core/baselineStore.ts:
// workspace-relative path, forward slashes, percent-encoded.
function seed(name, current, baseline) {
  fs.writeFileSync(path.join(root, name), current);
  if (baseline !== undefined) {
    fs.writeFileSync(path.join(baselines, encodeURIComponent(name)), baseline);
  }
}

// A small single-section edit — the everyday case.
seed(
  'greeting.ts',
  [
    'export function greet(name: string): string {',
    '  const trimmed = name.trim();',
    '  return `Hello, ${trimmed}!`;',
    '}',
    '',
  ].join('\n'),
  [
    'export function greet(name: string): string {',
    "  return 'Hello, ' + name;",
    '}',
    '',
  ].join('\n')
);

// Several separated sections in one file — the flow leads from one to the next
// as they are claimed, but any of them can be clicked into and typed first.
seed(
  'shopping-cart.ts',
  [
    'export interface Item {',
    '  name: string;',
    '  price: number;',
    '}',
    '',
    'export class Cart {',
    '  private items: Item[] = [];',
    '',
    '  add(item: Item): void {',
    '    if (item.price < 0) {',
    "      throw new Error('price must not be negative');",
    '    }',
    '    this.items.push(item);',
    '  }',
    '',
    '  remove(name: string): void {',
    '    this.items = this.items.filter((i) => i.name !== name);',
    '  }',
    '',
    '  total(): number {',
    '    const sum = this.items.reduce((acc, i) => acc + i.price, 0);',
    '    return Math.round(sum * 100) / 100;',
    '  }',
    '}',
    '',
  ].join('\n'),
  [
    'export interface Item {',
    '  name: string;',
    '  price: number;',
    '}',
    '',
    'export class Cart {',
    '  private items: Item[] = [];',
    '',
    '  add(item: Item): void {',
    '    this.items.push(item);',
    '  }',
    '',
    '  total(): number {',
    '    return this.items.reduce((sum, i) => sum + i.price, 0);',
    '  }',
    '}',
    '',
  ].join('\n')
);

// A file created from scratch: empty baseline, the whole file is one
// section — the overlay must show it fully, faded, never as an empty buffer.
seed(
  'agent-created.ts',
  [
    'export function formatBytes(bytes: number): string {',
    "  const units = ['B', 'KB', 'MB', 'GB'];",
    '  let value = bytes;',
    '  let unit = 0;',
    '  while (value >= 1024 && unit < units.length - 1) {',
    '    value /= 1024;',
    '    unit++;',
    '  }',
    '  return `${value.toFixed(1)} ${units[unit]}`;',
    '}',
    '',
  ].join('\n'),
  ''
);

// Removals only: nothing to retype, review is read-and-confirm.
seed(
  'cleanup.ts',
  [
    'export function parseConfig(raw: string): Record<string, string> {',
    '  const result: Record<string, string> = {};',
    "  for (const line of raw.split('\\n')) {",
    "    const [key, value] = line.split('=');",
    '    if (key && value) {',
    '      result[key.trim()] = value.trim();',
    '    }',
    '  }',
    '  return result;',
    '}',
    '',
  ].join('\n'),
  [
    'export function parseConfig(raw: string): Record<string, string> {',
    "  console.log('parseConfig input:', raw);",
    '  const result: Record<string, string> = {};',
    "  for (const line of raw.split('\\n')) {",
    "    console.log('line:', line);",
    "    const [key, value] = line.split('=');",
    '    if (key && value) {',
    '      result[key.trim()] = value.trim();',
    '    }',
    '  }',
    '  return result;',
    '}',
    '',
  ].join('\n')
);

// The two removals `cleanup.ts` cannot show: one line swapped for another — a
// replacement, whose removed line hides behind the added one — and a run
// deleted off the end of the file, which has no following line to mark. The
// last line is deliberately not a closing brace: a deleted trailing function
// leaves its `}` behind as common context, so a removal genuinely lands at the
// end of a file only when the file ends with something else.
seed(
  'trimmed.ts',
  ['export const MAX_RETRIES = 5;', 'export const BACKOFF_MS = 250;', ''].join('\n'),
  [
    'export const MAX_RETRIES = 3;',
    'export const BACKOFF_MS = 250;',
    '',
    "// Superseded by the queue's own backoff.",
    'export const LEGACY_TIMEOUT_MS = 5000;',
    'export const LEGACY_MAX_RETRIES = 10;',
    '',
  ].join('\n')
);

// Added, replaced and deleted lines interleaved through one file — the shape
// most real agent edits have, and the one every other file here takes apart
// into a single kind. Additions and replacements carry their own text; the
// deletion in `execute` has none, so it is the only change here the surface
// has to mark rather than colour.
seed(
  'overhaul.ts',
  [
    "import { readFile } from 'node:fs/promises';",
    "import { setTimeout as sleep } from 'node:timers/promises';",
    '',
    'export interface Job {',
    '  id: string;',
    '  attempts: number;',
    '  priority: number;',
    '}',
    '',
    'export class Runner {',
    '  private queue: Job[] = [];',
    '  private failed: Job[] = [];',
    '',
    '  constructor(private readonly limit: number, private readonly retries = 3) {}',
    '',
    '  push(job: Job): void {',
    '    this.queue.push(job);',
    '    this.queue.sort((a, b) => b.priority - a.priority);',
    '  }',
    '',
    '  async run(): Promise<void> {',
    '    const running: Promise<void>[] = [];',
    '    for (const job of this.queue.splice(0, this.limit)) {',
    '      running.push(this.execute(job));',
    '      await sleep(10);',
    '    }',
    '    await Promise.all(running);',
    '  }',
    '',
    '  private async execute(job: Job): Promise<void> {',
    '    job.attempts++;',
    "    await readFile(job.id, 'utf8');",
    '  }',
    '}',
    '',
  ].join('\n'),
  [
    "import { readFile } from 'node:fs/promises';",
    '',
    'export interface Job {',
    '  id: string;',
    '  attempts: number;',
    '}',
    '',
    'export class Runner {',
    '  private queue: Job[] = [];',
    '',
    '  constructor(private readonly limit: number) {}',
    '',
    '  push(job: Job): void {',
    '    this.queue.push(job);',
    '  }',
    '',
    '  async run(): Promise<void> {',
    '    for (const job of this.queue) {',
    '      await this.execute(job);',
    '    }',
    '  }',
    '',
    '  private async execute(job: Job): Promise<void> {',
    '    job.attempts++;',
    "    console.log('running', job.id);",
    "    console.log('attempt', job.attempts);",
    "    await readFile(job.id, 'utf8');",
    '  }',
    '}',
    '',
  ].join('\n')
);

// The worst case for the surface: something changed every line or two, so
// sections land next to each other and a deletion's boundary falls on a line
// that a neighbouring section already owns. Every mark the review can draw —
// dimmed text, a section highlight, a removal rule, a count in the margin, a
// lens strip — competes for the same few lines here. Deliberately denser than
// real code: if the surface stays readable on this file it stays readable
// anywhere.
seed(
  'churn.ts',
  [
    'const RETRY = 5;',
    'const TIMEOUT_MS = 1000;',
    '',
    'export function options(host: string) {',
    '  const opts = { host, timeout: TIMEOUT_MS, retries: RETRY };',
    '  const backoff = RETRY * 100;',
    '  return { ...opts, backoff };',
    '}',
    '',
  ].join('\n'),
  [
    'const RETRY = 3;',
    'const TIMEOUT_MS = 1000;',
    'const VERBOSE = false;',
    'const LEGACY_MODE = true;',
    '',
    'export function options(host: string) {',
    '  const label = `${host}:${TIMEOUT_MS}`;',
    '  const opts = { host, timeout: TIMEOUT_MS, retries: RETRY };',
    '  if (LEGACY_MODE) {',
    "    return { ...opts, label, protocol: 'v1' };",
    '  }',
    '  return { ...opts, label };',
    '}',
    '',
    'export function describe(host: string): string {',
    '  return `connecting to ${host}`;',
    '}',
    '',
  ].join('\n')
);

// Deepening indentation: exercises whitespace snapping (space/enter/tab all
// apply the target's indentation run).
seed(
  'indented.ts',
  [
    'export function walk(node: TreeNode): void {',
    '  for (const child of node.children) {',
    '    if (child.children.length > 0) {',
    '      walk(child);',
    '    }',
    '  }',
    '}',
    '',
    'export interface TreeNode {',
    '  children: TreeNode[];',
    '}',
    '',
  ].join('\n'),
  [
    'export function walk(node: TreeNode): void {',
    '  for (const child of node.children) {',
    '    walk(child);',
    '  }',
    '}',
    '',
    'export interface TreeNode {',
    '  children: TreeNode[];',
    '}',
    '',
  ].join('\n')
);

// A larger file where only a few separated sections changed: most of the file
// is untouched context, so the review has to jump across big unchanged
// regions. Built from shared segments so exactly three sections differ.
const rlTop = [
  'export interface RateLimitRule {',
  '  windowMs: number;',
  '  maxRequests: number;',
  '}',
  '',
  'export interface RateLimitResult {',
  '  allowed: boolean;',
  '  remaining: number;',
  '  retryAfterMs: number;',
  '}',
  '',
  'interface WindowState {',
  '  startedAt: number;',
  '  count: number;',
  '}',
  '',
  'const DEFAULT_RULE: RateLimitRule = {',
  '  windowMs: 60_000,',
  '  maxRequests: 100,',
  '};',
  '',
  'export class RateLimiter {',
  '  private windows = new Map<string, WindowState>();',
  '',
  '  constructor(private rule: RateLimitRule = DEFAULT_RULE) {}',
  '',
];
const rlCheckBody = [
  '    const state = this.windowFor(key, now);',
  '    if (state.count < this.rule.maxRequests) {',
  '      state.count++;',
  '      return {',
  '        allowed: true,',
  '        remaining: this.rule.maxRequests - state.count,',
  '        retryAfterMs: 0,',
  '      };',
  '    }',
  '    return {',
  '      allowed: false,',
  '      remaining: 0,',
  '      retryAfterMs: state.startedAt + this.rule.windowMs - now,',
  '    };',
  '  }',
  '',
  '  reset(key: string): void {',
  '    this.windows.delete(key);',
  '  }',
  '',
];
const rlBottom = [
  '',
  '  prune(now: number = Date.now()): number {',
  '    let removed = 0;',
  '    for (const [key, state] of this.windows) {',
  '      if (now - state.startedAt >= this.rule.windowMs) {',
  '        this.windows.delete(key);',
  '        removed++;',
  '      }',
  '    }',
  '    return removed;',
  '  }',
  '}',
  '',
];
seed(
  'rate-limiter.ts',
  [
    ...rlTop,
    '  check(key: string, now: number = Date.now()): RateLimitResult {',
    '    if (!key) {',
    "      throw new Error('rate limit key must not be empty');",
    '    }',
    ...rlCheckBody,
    '  private windowFor(key: string, now: number): WindowState {',
    '    let state = this.windows.get(key);',
    '    if (!state || now - state.startedAt >= this.rule.windowMs) {',
    '      state = { startedAt: now, count: 0 };',
    '      this.windows.set(key, state);',
    '    }',
    '    return state;',
    '  }',
    ...rlBottom,
    'export function describeRule(rule: RateLimitRule): string {',
    '  const perSecond = rule.maxRequests / (rule.windowMs / 1000);',
    '  return `${rule.maxRequests} requests per ${rule.windowMs}ms (${perSecond.toFixed(2)}/s)`;',
    '}',
    '',
  ].join('\n'),
  [
    ...rlTop,
    '  check(key: string, now: number = Date.now()): RateLimitResult {',
    ...rlCheckBody,
    '  private windowFor(key: string, now: number): WindowState {',
    '    let state = this.windows.get(key);',
    '    if (!state) {',
    '      state = { startedAt: now, count: 0 };',
    '      this.windows.set(key, state);',
    '    }',
    '    return state;',
    '  }',
    ...rlBottom,
  ].join('\n')
);

// C# with classes and deep, brace-heavy indentation: rewritten method bodies,
// a chained LINQ expression, and a new nested class — lots of indentation
// levels to exercise whitespace snapping in a brace language.
seed(
  'InventoryService.cs',
  [
    'using System;',
    'using System.Collections.Generic;',
    'using System.Linq;',
    '',
    'namespace Warehouse',
    '{',
    '    public class InventoryService',
    '    {',
    '        private readonly Dictionary<string, int> _stock = new();',
    '',
    '        public void Receive(string sku, int quantity)',
    '        {',
    '            if (quantity <= 0)',
    '            {',
    '                throw new ArgumentOutOfRangeException(nameof(quantity));',
    '            }',
    '            if (_stock.TryGetValue(sku, out var current))',
    '            {',
    '                _stock[sku] = current + quantity;',
    '            }',
    '            else',
    '            {',
    '                _stock[sku] = quantity;',
    '            }',
    '        }',
    '',
    '        public bool TryReserve(string sku, int quantity, out Reservation reservation)',
    '        {',
    '            reservation = null;',
    '            if (!_stock.TryGetValue(sku, out var available) || available < quantity)',
    '            {',
    '                return false;',
    '            }',
    '            _stock[sku] = available - quantity;',
    '            reservation = new Reservation(sku, quantity, DateTime.UtcNow);',
    '            return true;',
    '        }',
    '',
    '        public IEnumerable<string> LowStock(int threshold)',
    '        {',
    '            return _stock',
    '                .Where(entry => entry.Value < threshold)',
    '                .OrderBy(entry => entry.Value)',
    '                .Select(entry => entry.Key);',
    '        }',
    '',
    '        public sealed class Reservation',
    '        {',
    '            public Reservation(string sku, int quantity, DateTime at)',
    '            {',
    '                Sku = sku;',
    '                Quantity = quantity;',
    '                At = at;',
    '            }',
    '',
    '            public string Sku { get; }',
    '            public int Quantity { get; }',
    '            public DateTime At { get; }',
    '        }',
    '    }',
    '}',
    '',
  ].join('\n'),
  [
    'using System;',
    'using System.Collections.Generic;',
    'using System.Linq;',
    '',
    'namespace Warehouse',
    '{',
    '    public class InventoryService',
    '    {',
    '        private readonly Dictionary<string, int> _stock = new();',
    '',
    '        public void Receive(string sku, int quantity)',
    '        {',
    '            _stock[sku] = _stock.GetValueOrDefault(sku) + quantity;',
    '        }',
    '',
    '        public bool TryReserve(string sku, int quantity)',
    '        {',
    '            if (!_stock.TryGetValue(sku, out var available) || available < quantity)',
    '            {',
    '                return false;',
    '            }',
    '            _stock[sku] = available - quantity;',
    '            return true;',
    '        }',
    '',
    '        public IEnumerable<string> LowStock(int threshold)',
    '        {',
    '            return _stock.Where(e => e.Value < threshold).Select(e => e.Key);',
    '        }',
    '    }',
    '}',
    '',
  ].join('\n')
);

// A tracked-by-nobody file with no baseline: must not appear in the tree.
seed(
  'app.ts',
  ["import { greet } from './greeting';", '', "console.log(greet('world'));", ''].join(
    '\n'
  )
);

fs.writeFileSync(
  path.join(root, 'README.md'),
  [
    '# CopyWorkCode demo workspace',
    '',
    'Generated by `npm run demo:seed` — re-run it to reset every file.',
    'Open the review panel in the activity bar; each file demonstrates one case:',
    '',
    '- `greeting.ts` — a small everyday edit, one section.',
    '- `shopping-cart.ts` — several separated sections in one file.',
    '- `agent-created.ts` — a file created from scratch (empty baseline); the',
    '  whole file is one section, shown faded, never emptied.',
    '- `cleanup.ts` — removals only; each deletion is a confirm stop in the walk.',
    '- `trimmed.ts` — a line replaced and a run deleted off the end of the file:',
    '  the two removals that have no text of their own to mark.',
    '- `indented.ts` — deepening indentation; try space, enter, and tab at the',
    '  indent boundaries.',
    '- `rate-limiter.ts` — a larger file where only three separated sections',
    '  changed; most of the file is untouched context.',
    '- `InventoryService.cs` — C# classes with rewritten, deeply indented',
    '  method bodies and a new nested class.',
    '- `app.ts` — untracked, must not appear in the review tree.',
    '',
    'Things worth trying mid-review: the lens strip above the active section,',
    'Alt+J to snap back after scrolling away, the diff and stop buttons in the',
    'editor title bar, closing the review tab (the session must end), starting',
    'a second review while one is running, and pressing backspace or paste',
    '(both inert).',
    '',
  ].join('\n')
);

console.log(`Demo workspace ready: ${root}`);
