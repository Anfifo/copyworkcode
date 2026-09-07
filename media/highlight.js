/*
 * Coarse syntax colour for the change set page.
 *
 * Not a parser, and not trying to be one. The page shows whatever languages the
 * reviewer works in and has no language service to ask, so this splits a block
 * of lines into the five kinds of run that carry most of the reading benefit —
 * comment, string, number, keyword, type — and leaves everything else plain. A
 * run it gets wrong is coloured wrong; it is never *text* wrong, because the
 * tokens of a line concatenate back to that line character for character, which
 * is the one invariant a page built on retyping cannot do without.
 *
 * State carries from line to line inside a block, so a doc comment or a template
 * literal spanning several rows is one run rather than several guesses. It does
 * not carry between blocks: the page draws regions and context with collapsed
 * gaps between them, so a block is all the surrounding text there is. A block
 * that *starts* inside a comment is the one case worth catching, because it is
 * the common one — a changed region landing in the middle of a doc comment — and
 * it is cheap to spot: a closer with no opener before it means the text began
 * inside one.
 *
 * Colour is a reading aid, so a quote left unterminated stops at the end of its
 * own line rather than bleeding colour down the page. Only the delimiters that
 * are multi-line — template literals, triple quotes — carry over.
 */

(function () {
  /**
   * Words a family colours as keywords: a coarse union per family rather than a
   * grammar per language. `func` in a TypeScript file is a word that will not
   * appear on its own anyway, and being one keyword short of exact costs a
   * reading aid nothing — while a table per language would have to be kept.
   *
   * What the union cannot afford is a word that is also an everyday name. `set`,
   * `match`, `record`, `from` and `fn` are keywords somewhere and variables
   * everywhere, and a variable painted as a keyword is the loudest way a guess
   * like this reads as broken — so they are left out, and the member-name rule
   * below covers the rest.
   */
  const CODE_WORDS =
    'abstract as async await break case catch class const constexpr continue ' +
    'declare default defer delete do else enum export extends extern false ' +
    'finally for func function go goto if impl implements import in infer ' +
    'instanceof interface is keyof let loop module mut namespace new nil null of ' +
    'override package private protected pub public readonly return satisfies ' +
    'sealed sizeof static struct super switch synchronized this throw throws ' +
    'trait true try type typedef typeof unsafe use using var virtual void ' +
    'volatile where while with yield';

  const PYTHON_WORDS =
    'and as assert async await break class continue def del elif else except ' +
    'False finally for from global if import in is lambda None nonlocal not or ' +
    'pass raise return True try while with yield';

  const SHELL_WORDS =
    'case do done elif else esac exit export fi for function if in local return ' +
    'select then until while';

  const SQL_WORDS =
    'add all alter and as by column create delete distinct drop foreign from ' +
    'group having index inner insert into join key left limit not null offset on ' +
    'or order outer primary references returning right select set table union ' +
    'update values view where with';

  /**
   * What each family is made of. `multi` holds the delimiters that are the same
   * at both ends and may span lines; they are tried before `quotes` so `"""`
   * cannot be read as an empty `"` string.
   */
  const FAMILIES = {
    code: family(['//'], [['/*', '*/']], ['"', "'"], ['`'], CODE_WORDS),
    python: family(['#'], [], ['"', "'"], ['"""', "'''"], PYTHON_WORDS),
    shell: family(['#'], [], ['"', "'"], [], SHELL_WORDS),
    config: family(['#'], [], ['"', "'"], [], ''),
    sql: family(['--'], [['/*', '*/']], ["'", '"'], [], SQL_WORDS),
    css: family(['//'], [['/*', '*/']], ['"', "'"], [], ''),
    markup: family([], [['<!--', '-->']], ['"', "'"], [], ''),
    json: family(['//'], [['/*', '*/']], ['"'], [], 'true false null'),
  };

  /** Everything not named here is read as ordinary curly-brace code, which is
   * the bulk of what any change set holds. */
  const BY_NAME = {
    py: 'python',
    pyi: 'python',
    pyw: 'python',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    fish: 'shell',
    ps1: 'shell',
    mk: 'shell',
    makefile: 'shell',
    dockerfile: 'shell',
    yml: 'config',
    yaml: 'config',
    toml: 'config',
    ini: 'config',
    cfg: 'config',
    conf: 'config',
    env: 'config',
    properties: 'config',
    gitignore: 'config',
    sql: 'sql',
    css: 'css',
    scss: 'css',
    sass: 'css',
    less: 'css',
    html: 'markup',
    htm: 'markup',
    xml: 'markup',
    svg: 'markup',
    vue: 'markup',
    svelte: 'markup',
    md: 'markup',
    markdown: 'markup',
    json: 'json',
    jsonc: 'json',
    json5: 'json',
  };

  const WORD = /^[A-Za-z_$][A-Za-z0-9_$]*/;
  // A trailing letter run is part of the number: it is how a unit or a width
  // suffix is written, and `10px` reading as two runs would be worse than
  // either being wrong.
  const NUMBER =
    /^(?:0[xXbBoO][0-9a-fA-F_]+|[0-9][0-9_]*(?:\.[0-9_]+)?(?:[eE][+-]?[0-9]+)?)[A-Za-z_]*/;

  function family(line, block, quotes, multi, words) {
    return {
      line: line,
      block: block,
      quotes: quotes,
      multi: multi,
      words: new Set(words.split(' ').filter(Boolean)),
    };
  }

  /** The family a path belongs to: by extension, or by the whole name for the
   * files that carry their language in it rather than after a dot. */
  function familyOf(filename) {
    const name = String(filename || '').toLowerCase();
    const base = name.slice(name.lastIndexOf('/') + 1);
    const dot = base.lastIndexOf('.');
    const key = dot === -1 ? base : base.slice(dot + 1);
    return FAMILIES[BY_NAME[key]] || FAMILIES.code;
  }

  /**
   * One block of lines, tokenized together. Answers one array of `{text, cls}`
   * per line, where `cls` is '' for a run that is not coloured.
   */
  function tokenizeCode(lines, filename) {
    const grammar = familyOf(filename);
    const state = { closer: null, cls: '' };
    prime(lines, grammar, state);
    return lines.map((line) =>
      tokenizeLine(String(line == null ? '' : line), grammar, state)
    );
  }

  /** Whether this block opened inside a comment somebody else started. */
  function prime(lines, grammar, state) {
    if (grammar.block.length === 0) return;
    const pair = grammar.block[0];
    const text = lines.join('\n');
    const shut = text.indexOf(pair[1]);
    if (shut === -1) return;
    const open = text.indexOf(pair[0]);
    if (open !== -1 && open <= shut) return;
    state.closer = pair[1];
    state.cls = 'comment';
  }

  function tokenizeLine(line, grammar, state) {
    const out = [];
    let plain = '';
    let at = 0;
    const keep = (text, cls) => {
      if (text) out.push({ text: text, cls: cls });
    };
    const flush = () => {
      keep(plain, '');
      plain = '';
    };

    // Still inside whatever the last line left open.
    if (state.closer) {
      const shut = line.indexOf(state.closer);
      if (shut === -1) {
        keep(line, state.cls);
        return out;
      }
      at = shut + state.closer.length;
      keep(line.slice(0, at), state.cls);
      state.closer = null;
    }

    while (at < line.length) {
      const rest = line.slice(at);

      if (prefix(rest, grammar.line)) {
        flush();
        keep(rest, 'comment');
        return out;
      }

      const block = opener(rest, grammar.block);
      if (block) {
        flush();
        at += run(rest, block[0], block[1], 'comment', keep, state);
        continue;
      }

      const multi = prefix(rest, grammar.multi);
      if (multi) {
        flush();
        at += run(rest, multi, multi, 'string', keep, state);
        continue;
      }

      const quote = prefix(rest, grammar.quotes);
      if (quote) {
        flush();
        const end = closeQuote(rest, quote);
        keep(rest.slice(0, end), 'string');
        at += end;
        continue;
      }

      const number = NUMBER.exec(rest);
      if (number) {
        flush();
        keep(number[0], 'number');
        at += number[0].length;
        continue;
      }

      const word = WORD.exec(rest);
      if (word) {
        // A word with no colour of its own joins the plain run around it rather
        // than becoming a token: the page draws one node per token, and a line
        // of ordinary code is mostly words nobody needs coloured.
        const cls = classOf(word[0], grammar, at > 0 ? line[at - 1] : '');
        if (cls) {
          flush();
          keep(word[0], cls);
        } else {
          plain += word[0];
        }
        at += word[0].length;
        continue;
      }

      plain += line[at];
      at += 1;
    }
    flush();
    return out;
  }

  /**
   * A run that may not end on this line. Answers how much of `rest` it took,
   * and leaves the closer on the state when the line ran out first.
   */
  function run(rest, open, close, cls, keep, state) {
    const shut = rest.indexOf(close, open.length);
    if (shut === -1) {
      keep(rest, cls);
      state.closer = close;
      state.cls = cls;
      return rest.length;
    }
    const end = shut + close.length;
    keep(rest.slice(0, end), cls);
    return end;
  }

  /** Where a quoted run ends: past its closing quote, or at the end of the line
   * if there isn't one. Unterminated is left on its own line on purpose — a
   * stray apostrophe should cost one line of colour, not the rest of the page. */
  function closeQuote(rest, quote) {
    for (let i = quote.length; i < rest.length; i++) {
      if (rest[i] === '\\') {
        i++;
        continue;
      }
      if (rest.startsWith(quote, i)) return i + quote.length;
    }
    return rest.length;
  }

  function classOf(word, grammar, before) {
    // A word straight after a dot is a member name, whatever else it spells:
    // `map.get`, `x.type` and `text.match` are far more common than any language
    // in which those are keywords, and colouring them would be conspicuous.
    if (before !== '.' && grammar.words.has(word)) return 'keyword';
    // A leading capital is the only signal for a type with no language service
    // behind it, and nearly every language the page will show follows it. The
    // lowercase letter is what keeps SHOUTED constants out of it.
    if (/^[A-Z]/.test(word) && /[a-z]/.test(word)) return 'type';
    return '';
  }

  /** The first of these strings that `rest` starts with, if any. */
  function prefix(rest, candidates) {
    for (const candidate of candidates) {
      if (rest.startsWith(candidate)) return candidate;
    }
    return null;
  }

  function opener(rest, pairs) {
    for (const pair of pairs) {
      if (rest.startsWith(pair[0])) return pair;
    }
    return null;
  }

  window.tokenizeCode = tokenizeCode;
})();
