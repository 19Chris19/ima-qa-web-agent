(function (root) {
  const doc = root.document;

  // Lucide copy/arrow-down/x icon geometry, matching the existing inline icons.
  const icons = {
    copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    latest: '<path d="M12 5v14m-7-7 7 7 7-7"/>',
    close: '<path d="m18 6-12 12M6 6l12 12"/>',
  };
  function button(label, icon, className) {
    const node = doc.createElement('button');
    node.type = 'button';
    node.className = `qa-tool ${className || ''}`;
    node.title = label;
    node.setAttribute('aria-label', label);
    node.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[icon]}</svg>`;
    return node;
  }

  function composer(form, input) {
    // Measure compact width separately so stacked layout cannot oscillate.
    const mirror = doc.createElement('textarea');
    mirror.className = 'qa-measure';
    mirror.tabIndex = -1;
    mirror.setAttribute('aria-hidden', 'true');
    doc.body.append(mirror);
    function resize() {
      const style = root.getComputedStyle(input);
      const shell = root.getComputedStyle(form);
      const tools = form.querySelector('.composer-tools');
      const width = form.clientWidth - parseFloat(shell.paddingLeft || 0)
        - parseFloat(shell.paddingRight || 0) - (tools?.getBoundingClientRect().width || 42) - 10;
      mirror.style.font = style.font;
      mirror.style.lineHeight = style.lineHeight;
      mirror.style.width = `${Math.max(1, width)}px`;
      mirror.value = input.value;
      const line = parseFloat(style.lineHeight) || 24;
      form.dataset.layout = input.value && (input.value.includes('\n') || mirror.scrollHeight > line + 1)
        ? 'stacked' : 'compact';
      input.style.height = '0px';
      const height = input.value ? Math.max(line, input.scrollHeight) : line;
      input.style.height = `${Math.min(height, 144)}px`;
      input.style.overflowY = height > 144 ? 'auto' : 'hidden';
    }
    let lastWidth;
    const observer = root.ResizeObserver && new root.ResizeObserver(([entry]) => {
      if (entry.contentRect.width === lastWidth) return;
      lastWidth = entry.contentRect.width;
      root.requestAnimationFrame(resize);
    });
    observer?.observe(form);
    root.addEventListener('resize', resize);
    resize();
    return resize;
  }

  function answerText(markdown, sources = []) {
    const source = String(markdown ?? '');
    const marked = root.marked?.marked || root.marked;
    const known = new Set(sources.map(item => Number(item?.index))
      .filter(index => Number.isSafeInteger(index) && index > 0));
    if (!known.size || !marked) return source;
    const edits = [];
    // Port the website's token-boundary copy rule, editing the original Markdown
    // instead of serializing rendered HTML. Protected token contents stay exact.
    function visit(tokens, lower, upper) {
      let cursor = lower;
      for (const token of tokens || []) {
        const at = token.raw ? source.indexOf(token.raw, cursor) : -1;
        const located = at >= cursor && at + token.raw.length <= upper;
        const start = located ? at : cursor;
        const end = located ? at + token.raw.length : upper;
        if (token.type === 'link' && /^@context-ref\?id=\d+$/u.test(token.href || '')
            && known.has(Number(token.text))) {
          if (located) edits.push([start, end]);
        } else if (!['code', 'codespan', 'link', 'image', 'html', 'escape'].includes(token.type)) {
          if (token.type === 'text' && !token.tokens && located) {
            for (const match of token.raw.matchAll(/(?<!\\)\[(\d+)\]/gu)) {
              if (known.has(Number(match[1]))) edits.push([start + match.index, start + match.index + match[0].length]);
            }
          } else {
            let childCursor = visit(token.tokens, start, end);
            for (const item of token.items || []) childCursor = visit(item.tokens, childCursor, end);
            for (const cell of [...(token.header || []), ...(token.rows || []).flat()]) childCursor = visit(cell.tokens, childCursor, end);
            if (!located) cursor = childCursor;
          }
        }
        if (located) cursor = end;
      }
      return cursor;
    }
    visit(marked.lexer(source, { gfm: true }), 0, source.length);
    let result = source;
    for (const [start, end] of edits.sort((a, b) => b[0] - a[0])) result = result.slice(0, start) + result.slice(end);
    return result;
  }

  const feedbackTimers = new WeakMap();
  async function copyText(text, host, trigger, valid = () => host.isConnected) {
    root.clearTimeout(feedbackTimers.get(host));
    host.querySelector('.copy-fallback')?.remove();
    const status = host.querySelector('.copy-status');
    if (status) status.textContent = '';
    try {
      await root.navigator.clipboard.writeText(text);
      if (valid() && status) {
        status.textContent = '已复制';
        feedbackTimers.set(host, root.setTimeout(() => {
          if (valid()) status.textContent = '';
          feedbackTimers.delete(host);
        }, 1500));
      }
    } catch {
      if (!valid()) return;
      if (status) status.textContent = '复制失败，请选择下方文字复制';
      const fallback = doc.createElement('div');
      fallback.className = 'copy-fallback';
      const field = doc.createElement('textarea');
      field.readOnly = true;
      field.value = text;
      field.setAttribute('aria-label', '可选择复制的文字');
      const close = button('关闭可复制文字', 'close');
      const dismiss = () => { fallback.remove(); trigger.focus({ preventScroll: true }); };
      close.addEventListener('click', dismiss);
      field.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.stopPropagation(); dismiss(); }
      });
      fallback.append(field, close);
      host.append(fallback);
      field.focus({ preventScroll: true });
      field.select();
    }
  }

  function answerCopy(view, partial = false) {
    if (!view.answer?.trim() || view.bubble.querySelector('.answer-tools')) return;
    const tools = doc.createElement('div');
    tools.className = 'answer-tools';
    const copy = button(partial ? '复制已收到的部分回答' : '复制回答', 'copy', 'answer-copy');
    const status = doc.createElement('span');
    status.className = 'copy-status';
    status.setAttribute('role', 'status');
    tools.append(copy, status);
    view.bubble.append(tools);
    copy.addEventListener('click', async () => {
      copy.disabled = true;
      try {
        await copyText(answerText(view.answer, view.sources), tools, copy);
      } finally { copy.disabled = false; }
    });
  }

  function selectionCopy(log) {
    const toolbar = doc.createElement('div');
    toolbar.className = 'selection-copy-toolbar';
    toolbar.setAttribute('role', 'group');
    toolbar.setAttribute('aria-label', '选中文字操作');
    toolbar.hidden = true;
    const copy = button('复制选中文字', 'copy');
    const status = doc.createElement('span');
    status.className = 'copy-status';
    status.setAttribute('role', 'status');
    toolbar.append(copy, status);
    doc.body.append(toolbar);
    let current = null;
    let blocked = null;
    const same = (a, b) => a && b && a.startContainer === b.startContainer && a.startOffset === b.startOffset
      && a.endContainer === b.endContainer && a.endOffset === b.endOffset;
    function restoreSelection() {
      if (!current) return;
      const selection = root.getSelection();
      selection.removeAllRanges();
      selection.addRange(current.range.cloneRange());
    }
    function hide() {
      blocked = current?.range || blocked;
      current = null;
      toolbar.hidden = true;
      toolbar.querySelector('.copy-fallback')?.remove();
      status.textContent = '';
    }
    function refresh() {
      if (toolbar.contains(doc.activeElement)) return;
      const selection = root.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return hide();
      const range = selection.getRangeAt(0);
      const node = range.startContainer;
      const answer = (node.nodeType === 1 ? node : node.parentElement)?.closest('.message.assistant .answer-markdown');
      if (!answer || !log.contains(answer) || !answer.contains(range.endContainer)
        || !selection.toString().trim() || same(range, blocked)) return hide();
      const rect = range.getBoundingClientRect();
      if (!same(range, current?.range) || current.text !== selection.toString()) {
        current = { range: range.cloneRange(), text: selection.toString(), answer };
        status.textContent = '';
      }
      toolbar.hidden = false;
      toolbar.style.left = `${Math.max(8, Math.min(root.innerWidth - 200, rect.left))}px`;
      toolbar.style.top = `${Math.max(8, Math.min(root.innerHeight - 180, rect.bottom + 8))}px`;
    }
    copy.addEventListener('pointerdown', event => event.preventDefault());
    copy.addEventListener('click', async () => {
      if (!current) return;
      const captured = current;
      copy.disabled = true;
      await copyText(captured.text, toolbar, copy, () => current === captured && !toolbar.hidden);
      copy.disabled = false;
      if (current !== captured) toolbar.querySelector('.copy-fallback')?.remove();
      else if (!toolbar.querySelector('.copy-fallback')) restoreSelection();
    });
    doc.addEventListener('selectionchange', refresh);
    doc.addEventListener('pointerup', event => { if (log.contains(event.target)) refresh(); });
    doc.addEventListener('pointerdown', event => {
      if (!toolbar.contains(event.target)) {
        hide();
        if (event.target.closest?.('.message.assistant .answer-markdown')) blocked = null;
      }
    });
    doc.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        if (toolbar.contains(doc.activeElement)) current?.answer.focus({ preventScroll: true });
        hide();
      }
      // Bring the contextual action into the keyboard path without stealing selection focus.
      if (event.key === 'Tab' && !event.shiftKey && !toolbar.hidden && !toolbar.contains(doc.activeElement)) {
        event.preventDefault();
        copy.focus({ preventScroll: true });
        restoreSelection();
      }
    });
    doc.addEventListener('scroll', hide, true);
    root.addEventListener('resize', hide);
    new root.MutationObserver(() => {
      if (current && (!current.answer.isConnected || current.range.toString() !== current.text)) hide();
    }).observe(log, { subtree: true, childList: true, characterData: true });
  }

  root.ProviderQaExperience = { button, composer, answerText, answerCopy, selectionCopy };
})(globalThis);
