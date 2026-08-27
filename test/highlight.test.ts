import { strict as assert } from 'assert';
import { test } from 'node:test';
import { mediaSource } from './helpers/pageDom';

/**
 * The change set page's highlighter (`media/highlight.js`), run as the page runs
 * it: the shipped file, with a `window` to hang itself off.
 *
 * The one thing here that is not a matter of taste is the invariant — a line's
 * tokens have to concatenate back to that line, character for character, or the
 * page would draw code that is not the code the reviewer owes. Everything else
 * is a reading aid, so what these tests fix is the shape of the guesses it makes
 * and where it deliberately stops guessing: unterminated quotes stay on their
 * own line, and only the delimiters that really span lines carry over.
 */

interface Token {
  text: string;
  cls: string;
}

type Tokenize = (lines: string[], filename: string) => Token[][];

const tokenize: Tokenize = (() => {
  const window: Record<string, unknown> = {};
  new Function('window', mediaSource('highlight.js'))(window);
  return window.tokenizeCode as Tokenize;
})();

/** One line's tokens as `cls:text` runs, to assert a whole line in one string. */
function shape(tokens: Token[]): string {
  return tokens.map((token) => `${token.cls || 'plain'}:${token.text}`).join('|');
}

/** Every class a line was split into, in order, with plain runs dropped. */
function classes(tokens: Token[]): string[] {
  return tokens.filter((token) => token.cls).map((token) => token.cls);
}

const one = (line: string, name = 'a.ts') => tokenize([line], name)[0];

test('a line is split into runs that add back up to the line', () => {
  const lines = [
    'export function add(a: number, b = 0x1f): Widget {',
    '  // a comment with a "quote" and 12 in it',
    `  const label = 'it\\'s here'; /* trailing */`,
    '  return new Widget(`sum ${a + b}`, 3.5e2, /re?gex/);',
    '',
    '\tif (SHOUTED === null) return null;',
  ];

  for (const [name, text] of [
    ['a.ts', lines],
    ['b.py', lines],
    ['c.css', lines],
    ['d.md', lines],
    ['no-extension', lines],
  ] as const) {
    const drawn = tokenize(text as string[], name as string);
    assert.equal(drawn.length, lines.length);
    drawn.forEach((tokens, i) => {
      assert.equal(
        tokens.map((token) => token.text).join(''),
        lines[i],
        `${name} line ${i} survives tokenizing`
      );
    });
  }
});

test('an empty line has nothing in it to colour', () => {
  assert.deepEqual(one(''), []);
});

test('the coarse runs of a line of code are picked out', () => {
  const tokens = one('const total = 12; // the sum');

  assert.equal(
    shape(tokens),
    ['keyword:const', 'plain: total = ', 'number:12', 'plain:; ', 'comment:// the sum'].join(
      '|'
    )
  );
});

test('a name is a type by its capital, and a shouted one is not', () => {
  assert.deepEqual(classes(one('let widget = new Widget(SIZE);')), [
    'keyword',
    'keyword',
    'type',
  ]);
});

test('a string keeps what would otherwise be read as code', () => {
  assert.equal(
    shape(one('const path = "// not a comment";')),
    ['keyword:const', 'plain: path = ', 'string:"// not a comment"', 'plain:;'].join('|')
  );
});

test('an escaped quote does not end its string', () => {
  assert.equal(shape(one(`'it\\'s one string'`)), `string:'it\\'s one string'`);
});

test('a quote left open costs its own line and no more', () => {
  const drawn = tokenize([`const broken = 'oops`, 'const after = 1;'], 'a.ts');

  assert.deepEqual(classes(drawn[0]), ['keyword', 'string']);
  assert.deepEqual(classes(drawn[1]), ['keyword', 'number'], 'the next line is code again');
});

test('a block comment runs on until it closes, and the code after it does not', () => {
  const drawn = tokenize(
    ['/* what this does', ' * over two lines', ' */ const after = 1;'], 'a.ts'
  );

  assert.deepEqual(classes(drawn[0]), ['comment']);
  assert.deepEqual(classes(drawn[1]), ['comment']);
  assert.equal(
    shape(drawn[2]),
    ['comment: */', 'plain: ', 'keyword:const', 'plain: after = ', 'number:1', 'plain:;'].join(
      '|'
    )
  );
});

test('a block that begins inside a comment is read as being inside one', () => {
  // The common case for a page drawn in regions: a changed region landing in the
  // middle of a doc comment, with the opener several collapsed lines above it.
  const drawn = tokenize([' * the tail of a comment', ' */', 'const after = 1;'], 'a.ts');

  assert.deepEqual(classes(drawn[0]), ['comment']);
  assert.deepEqual(classes(drawn[1]), ['comment']);
  assert.deepEqual(classes(drawn[2]), ['keyword', 'number'], 'and the code after it is code');
});

test('a template literal is one string across the lines it spans', () => {
  const drawn = tokenize(['const sql = `select', '  from t`;'], 'a.ts');

  assert.deepEqual(classes(drawn[0]), ['keyword', 'string']);
  assert.equal(shape(drawn[1]), ['string:  from t`', 'plain:;'].join('|'));
});

test('the language comes from the file name', () => {
  assert.deepEqual(classes(one('# not a comment here', 'a.ts')), []);
  assert.deepEqual(classes(one('# a comment here', 'a.py')), ['comment']);
  assert.deepEqual(classes(one('def add(a, b):', 'a.py')), ['keyword']);
  assert.deepEqual(classes(one('-- gone in sql', 'a.sql')), ['comment']);
  assert.deepEqual(classes(one('<!-- markup -->', 'a.md')), ['comment']);
  assert.equal(
    classes(one('SELECT id FROM t', 'a.sql')).length,
    0,
    'and its keywords are the ones that family writes in lower case'
  );
});

test('a docstring is one string across the lines it spans', () => {
  const drawn = tokenize(
    ['def f():', '    """what f does', '    over two lines"""', '    return 1'],
    'a.py'
  );

  assert.deepEqual(classes(drawn[0]), ['keyword']);
  assert.deepEqual(classes(drawn[1]), ['string']);
  assert.deepEqual(classes(drawn[2]), ['string']);
  assert.deepEqual(classes(drawn[3]), ['keyword', 'number']);
});

test('a number keeps the suffix it was written with', () => {
  assert.equal(shape(one('width: 10px;', 'a.css')), 'plain:width: |number:10px|plain:;');
  assert.deepEqual(
    one('id1 = 1', 'a.ts')
      .filter((token) => token.cls === 'number')
      .map((token) => token.text),
    ['1'],
    'and a name that ends in digits is one name, not a name and a number'
  );
});
