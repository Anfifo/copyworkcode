/*
 * The change set page: one continuous document of every changed region in the
 * queue, retyped in place.
 *
 * The page holds no judgement of its own. Every gesture is sent to the
 * extension, which owns the matching engine and every region's progress, and
 * the page redraws from what comes back. That is what makes typing here count
 * for the same thing as typing in an editor: there is one implementation of the
 * rules, and neither surface has its own copy.
 *
 * Code is written into the document as text nodes, never as markup — a file's
 * own contents can never become part of this page's structure.
 */

(function () {
  const vscode = acquireVsCodeApi();

  /** The document as the extension last sent it. */
  let payload = { baselineLabel: '', files: [] };
  /** File path to its payload, for a message to find one by name. */
  const byPath = new Map();
  /** File path to its rendered parts. */
  const drawn = new Map();
  /** The one region keystrokes go to: `{ file, index }`, or null. */
  let active = null;

  const doc = document.getElementById('doc');
  const summary = document.getElementById('summary');
  const status = document.getElementById('status');

  document.getElementById('reload').addEventListener('click', (event) => {
    // Keystrokes belong to the document, so no button ever keeps the focus.
    event.currentTarget.blur();
    doc.focus();
    vscode.postMessage({ type: 'reload' });
  });

  window.addEventListener('message', (event) => receive(event.data));
  document.addEventListener('keydown', onKey);
  doc.addEventListener('click', onClick);
  vscode.postMessage({ type: 'ready' });

  // --- messages -------------------------------------------------------------

  function receive(message) {
    if (!message) return;
    switch (message.type) {
      case 'set':
        payload = message;
        render();
        return;
      case 'section': {
        const file = byPath.get(message.file);
        if (!file) return;
        file.states[message.index] = message.state;
        paint(message.file, message.index);
        if (message.state.outcome && isActive(message.file, message.index)) {
          moveOn();
        }
        updateFile(message.file);
        updateStatus();
        return;
      }
      case 'file': {
        // The page gave this file up to an editor review: every region owed
        // again, and the caret out of it if it was sitting there.
        const file = byPath.get(message.file);
        if (!file) return;
        file.states = message.states;
        for (let i = 0; i < file.states.length; i++) paint(message.file, i);
        if (active && active.file === message.file) moveOn();
        updateFile(message.file);
        updateStatus();
        return;
      }
      case 'gap':
        fillGap(message);
        return;
      case 'done': {
        const parts = drawn.get(message.file);
        if (!parts) return;
        parts.root.classList.add('done');
        parts.progress.textContent = 'reviewed — ' + message.summary;
        updateSummary();
        return;
      }
      case 'reject':
        flash(message.file, message.index);
        return;
    }
  }

  // --- rendering ------------------------------------------------------------

  function render() {
    doc.textContent = '';
    byPath.clear();
    drawn.clear();
    active = null;
    for (const file of payload.files) {
      byPath.set(file.file, file);
      doc.appendChild(renderFile(file));
    }
    for (const file of payload.files) {
      for (let i = 0; i < file.states.length; i++) paint(file.file, i);
      updateFile(file.file);
    }
    updateSummary();
    moveOn();
    doc.focus();
  }

  function renderFile(file) {
    const root = el('section', 'file');
    root.dataset.file = file.file;

    const head = el('div', 'file-head');
    head.appendChild(span('path', file.relative));
    const counts = el('span', 'counts');
    counts.appendChild(span('added-count', '+' + file.addedLines));
    counts.appendChild(document.createTextNode(' '));
    counts.appendChild(span('removed-count', '−' + file.removedLines));
    head.appendChild(counts);
    if (file.isNew) head.appendChild(span('muted', 'new file'));
    const progress = el('span', 'progress muted');
    head.appendChild(progress);
    head.appendChild(action('secondary', 'Open in editor', {
      type: 'openInEditor',
      file: file.file,
      line: firstLine(file),
    }));
    root.appendChild(head);

    const sections = new Map();
    for (const block of file.blocks) {
      if (block.kind === 'context') {
        root.appendChild(codeBlock('code-block context', block.lines));
      } else if (block.kind === 'gap') {
        root.appendChild(gapButton(file, block));
      } else {
        const parts = renderSection(file, block.section);
        sections.set(block.section.index, parts);
        root.appendChild(parts.el);
      }
    }
    drawn.set(file.file, { root, progress, sections });
    return root;
  }

  function renderSection(file, section) {
    const node = el('div', 'section');
    node.dataset.file = file.file;
    node.dataset.index = String(section.index);

    const lens = el('div', 'lens');
    node.appendChild(lens);
    if (section.removedLines.length > 0) {
      node.appendChild(removedBlock(section.removedLines));
    }
    const added = el('div', 'code-block added');
    const rows = [];
    if (section.kind === 'type') {
      // The rows are built once and rewritten in place from then on. A region
      // can be a whole new file, and a keystroke is no reason to build one
      // again — see paintCode.
      let start = 0;
      for (const line of section.addedLines) {
        const row = el('div', 'row');
        row.appendChild(span('n', String(line.n)));
        const text = el('span', 'text');
        row.appendChild(text);
        added.appendChild(row);
        rows.push({ text, line: line.text, start, covered: -1, caret: false });
        start += line.text.length + 1;
      }
      node.appendChild(added);
    }
    return { el: node, lens, added, rows, section };
  }

  /** Lines the change took away, in the place they were. */
  function removedBlock(lines) {
    const block = el('div', 'code-block removed');
    for (const text of lines) {
      const row = el('div', 'row');
      row.appendChild(span('n', '−'));
      row.appendChild(span('text', text));
      block.appendChild(row);
    }
    return block;
  }

  function codeBlock(className, lines) {
    const block = el('div', className);
    for (const line of lines) {
      const row = el('div', 'row');
      row.appendChild(span('n', String(line.n)));
      row.appendChild(span('text', line.text));
      block.appendChild(row);
    }
    return block;
  }

  function gapButton(file, block) {
    const held = block.to - block.from + 1;
    const node = el('button', 'gap');
    node.type = 'button';
    node.dataset.file = file.file;
    node.dataset.from = String(block.from);
    node.dataset.to = String(block.to);
    node.textContent =
      '⋯ ' + held + (held === 1 ? ' line' : ' lines') + ' unchanged';
    return node;
  }

  function fillGap(message) {
    const parts = drawn.get(message.file);
    if (!parts) return;
    const selector =
      '.gap[data-from="' + message.from + '"][data-to="' + message.to + '"]';
    const node = parts.root.querySelector(selector);
    if (!node) return;
    node.replaceWith(codeBlock('code-block context', message.lines));
  }

  // --- one region -----------------------------------------------------------

  /**
   * Redraw a region from its state: the text it owes, the caret at the position
   * the next keystroke lands on, and the strip above it.
   */
  function paint(file, index) {
    const parts = drawn.get(file);
    const data = byPath.get(file);
    if (!parts || !data) return;
    const region = parts.sections.get(index);
    const state = data.states[index];
    if (!region || !state) return;

    const section = region.section;
    const live = isActive(file, index);
    region.el.classList.toggle('active', live);
    region.el.classList.toggle('claimed', Boolean(state.outcome));

    if (section.kind === 'type') paintCode(region, state);
    paintLens(region, data, section, state, live);
    if (live) keepCaretInView(region);
  }

  /**
   * Bring a region's code up to date with its progress, touching only the rows
   * whose share of it moved — a keystroke moves the row the caret sits on and
   * the row it just left, a fill can cross a handful. The arithmetic runs over
   * every row because it is cheap; the writing does not, because it is not. A
   * region is as large as a new file is long, and redrawing all of it on every
   * character is felt on exactly the change sets this page exists for.
   */
  function paintCode(region, state) {
    const caretRow = state.outcome ? -1 : rowAt(region.rows, state.position);
    for (let i = 0; i < region.rows.length; i++) {
      const row = region.rows[i];
      const covered = Math.max(0, Math.min(state.position - row.start, row.line.length));
      const caret = i === caretRow;
      if (row.covered === covered && row.caret === caret) continue;
      row.covered = covered;
      row.caret = caret;
      drawRow(row);
    }
  }

  /**
   * The row the next keystroke lands on: the first one the position is inside,
   * counting the end of a line as still on it rather than at the head of the
   * next one — a line break is typed where the line ends.
   */
  function rowAt(rows, position) {
    for (let i = 0; i < rows.length; i++) {
      if (position <= rows[i].start + rows[i].line.length) return i;
    }
    return -1;
  }

  /** One row's text: what has been covered, the caret, and what is still owed. */
  function drawRow(row) {
    row.text.textContent = '';
    if (row.covered > 0) {
      row.text.appendChild(span('covered', row.line.slice(0, row.covered)));
    }
    if (row.caret) row.text.appendChild(el('span', 'caret'));
    if (row.covered < row.line.length) {
      row.text.appendChild(span('owed', row.line.slice(row.covered)));
    }
  }

  /**
   * The strip above a region. What it offers is what the region needs: progress
   * and the fills while it is the one being worked on, a way in while it is
   * not, and how it was dealt with once it is closed.
   */
  function paintLens(region, file, section, state, live) {
    const lens = region.lens;
    lens.textContent = '';
    const lost = section.removedLines.length;
    if (lost > 0) {
      lens.appendChild(
        span(
          'lost',
          lost +
            (lost === 1 ? ' line ' : ' lines ') +
            (section.kind === 'confirm' ? 'removed' : 'replaced')
        )
      );
    }
    if (state.outcome) {
      lens.appendChild(span('outcome', state.outcome));
      return;
    }
    if (!live) {
      lens.appendChild(action('secondary', 'Start here', null, region));
      return;
    }
    if (section.kind === 'confirm') {
      lens.appendChild(
        action('', 'Confirm (Enter)', {
          type: 'confirm',
          file: file.file,
          index: section.index,
        })
      );
    } else {
      lens.appendChild(
        span('muted', 'typed ' + state.position + '/' + section.target.length)
      );
      lens.appendChild(
        action('secondary', 'Fill line (Alt+F)', {
          type: 'fillLine',
          file: file.file,
          index: section.index,
        })
      );
      lens.appendChild(
        action('secondary', 'Skip (Alt+S)', {
          type: 'skip',
          file: file.file,
          index: section.index,
        })
      );
    }
    lens.appendChild(
      action('secondary', 'Open here', {
        type: 'openInEditor',
        file: file.file,
        line: section.line,
      })
    );
  }

  function flash(file, index) {
    const parts = drawn.get(file);
    const region = parts && parts.sections.get(index);
    if (!region) return;
    region.el.classList.add('wrong');
    setTimeout(() => region.el.classList.remove('wrong'), 220);
    status.textContent = 'wrong key — that is not what this region says.';
  }

  // --- what the keystrokes go to -------------------------------------------

  function isActive(file, index) {
    return active !== null && active.file === file && active.index === index;
  }

  function setActive(file, index) {
    const was = active;
    active = { file, index };
    if (was) paint(was.file, was.index);
    paint(file, index);
    const parts = drawn.get(file);
    const region = parts && parts.sections.get(index);
    if (region) region.el.scrollIntoView({ block: 'center' });
    updateStatus();
  }

  /** Move to the next region still owed, in the order the page reads. */
  function moveOn() {
    const from = active;
    active = null;
    const next = nextOwed(from);
    if (!next) {
      if (from) paint(from.file, from.index);
      updateStatus();
      return;
    }
    active = next;
    if (from) paint(from.file, from.index);
    paint(next.file, next.index);
    const parts = drawn.get(next.file);
    const region = parts && parts.sections.get(next.index);
    if (region) region.el.scrollIntoView({ block: 'center' });
    updateStatus();
  }

  /**
   * The first region still owed at or after `from`, wrapping around — the same
   * convenience the editor review offers, and no more of a rule here than
   * there: clicking into any region at any time is free.
   */
  function nextOwed(from) {
    const owed = [];
    for (const file of payload.files) {
      for (let i = 0; i < file.states.length; i++) {
        if (!file.states[i].outcome) owed.push({ file: file.file, index: i });
      }
    }
    if (owed.length === 0) return null;
    if (!from) return owed[0];
    const order = payload.files.map((file) => file.file);
    const rank = (spot) => order.indexOf(spot.file) * 1e6 + spot.index;
    const after = rank(from);
    return owed.find((spot) => rank(spot) > after) || owed[0];
  }

  function onClick(event) {
    const button = event.target.closest('button');
    if (button) {
      onAction(button);
      return;
    }
    const region = event.target.closest('.section');
    if (!region) return;
    const index = Number(region.dataset.index);
    const file = byPath.get(region.dataset.file);
    if (file && !file.states[index].outcome) setActive(region.dataset.file, index);
  }

  function onAction(button) {
    // Keystrokes belong to the document, so the button never keeps the focus.
    button.blur();
    doc.focus();
    if (button.classList.contains('gap')) {
      vscode.postMessage({
        type: 'expandGap',
        file: button.dataset.file,
        from: Number(button.dataset.from),
        to: Number(button.dataset.to),
      });
      return;
    }
    const region = button.closest('.section');
    if (button.dataset.start === 'here' && region) {
      setActive(region.dataset.file, Number(region.dataset.index));
      return;
    }
    if (button.dataset.send) vscode.postMessage(JSON.parse(button.dataset.send));
  }

  function onKey(event) {
    // AltGr is how a good many layouts reach the characters code is written
    // with, and it arrives as Ctrl+Alt — so it has to be told apart from both
    // before either is dismissed, or the page refuses to type a brace.
    const altGraph =
      (event.getModifierState && event.getModifierState('AltGraph')) ||
      (event.ctrlKey && event.altKey);
    if (!altGraph && (event.ctrlKey || event.metaKey)) return; // copying, zooming
    if (event.altKey && !altGraph) {
      const key = event.key.toLowerCase();
      if (key === 'f') return gesture(event, 'fillLine');
      if (key === 's') return gesture(event, 'skip');
      if (key === 'j' && active) {
        event.preventDefault();
        setActive(active.file, active.index);
      }
      return;
    }
    if (!active) return;
    const section = sectionAt(active);
    if (!section) return;
    if (section.kind === 'confirm') {
      // Nothing to type: the one gesture a deletion asks for is acknowledgement.
      if (event.key === 'Enter' || event.key === ' ') gesture(event, 'confirm');
      return;
    }
    if (event.key === 'Enter') return typed(event, '\n');
    if (event.key === 'Tab') return gesture(event, 'fillWord');
    if (event.key.length === 1) return typed(event, event.key);
    // Everything else — arrows, page keys, Home, End — scrolls the page.
  }

  function typed(event, text) {
    event.preventDefault();
    status.textContent = '';
    vscode.postMessage({
      type: 'type',
      file: active.file,
      index: active.index,
      text,
    });
  }

  function gesture(event, type) {
    if (!active) return;
    event.preventDefault();
    status.textContent = '';
    vscode.postMessage({ type, file: active.file, index: active.index });
  }

  function sectionAt(spot) {
    const parts = drawn.get(spot.file);
    const region = parts && parts.sections.get(spot.index);
    return region ? region.section : null;
  }

  /** Follow the caret when typing walks it past the edge of the viewport. */
  function keepCaretInView(region) {
    const caret = region.added.querySelector('.caret');
    if (!caret) return;
    const box = caret.getBoundingClientRect();
    if (box.top < 90 || box.bottom > window.innerHeight - 70) {
      caret.scrollIntoView({ block: 'center' });
    }
  }

  // --- the bars -------------------------------------------------------------

  function updateFile(file) {
    const parts = drawn.get(file);
    const data = byPath.get(file);
    if (!parts || !data || parts.root.classList.contains('done')) return;
    const claimed = data.states.filter((state) => state.outcome).length;
    parts.progress.textContent =
      claimed === 0
        ? data.states.length + (data.states.length === 1 ? ' region' : ' regions')
        : claimed + ' of ' + data.states.length + ' claimed';
    updateSummary();
  }

  function updateSummary() {
    const files = payload.files;
    let owed = 0;
    let added = 0;
    let removed = 0;
    for (const file of files) {
      owed += file.states.filter((state) => !state.outcome).length;
      added += file.addedLines;
      removed += file.removedLines;
    }
    if (files.length === 0) {
      summary.textContent = 'Nothing is waiting for review.';
      return;
    }
    summary.textContent =
      files.length +
      (files.length === 1 ? ' file · +' : ' files · +') +
      added +
      ' −' +
      removed +
      ' · ' +
      owed +
      (owed === 1 ? ' region still owed' : ' regions still owed') +
      ' · compared against ' +
      payload.baselineLabel;
  }

  function updateStatus() {
    if (!active) {
      status.textContent =
        payload.files.length === 0
          ? ''
          : 'Every region on this page is claimed.';
      return;
    }
    const file = byPath.get(active.file);
    const section = sectionAt(active);
    const state = file && file.states[active.index];
    if (!file || !section || !state) return;
    const where = file.relative + ':' + section.line;
    status.textContent =
      section.kind === 'confirm'
        ? where + ' · ' + section.removedLines.length + ' line(s) removed — Enter confirms'
        : where + ' · typed ' + state.position + '/' + section.target.length;
  }

  // --- small things ---------------------------------------------------------

  function el(tag, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function span(className, text) {
    const node = el('span', className);
    node.textContent = text;
    return node;
  }

  /** A button that either sends one message or, with none, starts a region. */
  function action(className, label, message, region) {
    const node = el('button', className);
    node.type = 'button';
    node.textContent = label;
    if (message) node.dataset.send = JSON.stringify(message);
    else if (region) node.dataset.start = 'here';
    return node;
  }

  function firstLine(file) {
    for (const block of file.blocks) {
      if (block.kind === 'section') return block.section.line;
    }
    return 1;
  }
})();
