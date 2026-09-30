(function (root) {
  const marked = root.marked?.marked || root.marked;
  const purifier = root.DOMPurify;
  const allowedTags = [
    'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del',
    'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'a', 'table', 'thead', 'tbody',
    'tr', 'th', 'td', 'div', 'span',
  ];

  function escapeHtml(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function safeHref(value) {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
    } catch {
      return '';
    }
  }

  function stripKnownCitations(tokens, known) {
    for (const token of tokens || []) {
      if (token.type === 'link' && /^@context-ref\?id=\d+$/u.test(String(token.href || ''))
          && known.has(Number(token.text))) {
        token.type = 'text';
        token.text = '';
        token.tokens = [];
        continue;
      }
      if (token.type === 'text') {
        if (Array.isArray(token.tokens)) stripKnownCitations(token.tokens, known);
        else token.text = token.text.replace(/(?<!\\)\[(\d+)\]/gu,
          (whole, index) => known.has(Number(index)) ? '' : whole);
      } else if (!['code', 'codespan', 'link', 'image'].includes(token.type)) {
        if (Array.isArray(token.tokens)) stripKnownCitations(token.tokens, known);
        for (const item of token.items || []) stripKnownCitations(item.tokens, known);
        for (const cell of [...(token.header || []), ...(token.rows || []).flat()]) {
          stripKnownCitations(cell.tokens, known);
        }
      }
    }
  }

  function tableCells(line) {
    return line.trim().replace(/^\|/u, '').replace(/(?<!\\)\|$/u, '')
      .split(/(?<!\\)\|/u).map((cell) => cell.trim());
  }

  function partitionMalformedTables(input) {
    const lines = input.split('\n');
    const parts = [];
    let plain = [];
    const flush = () => {
      if (plain.length) parts.push({ type: 'markdown', text: plain.join('\n') });
      plain = [];
    };
    for (let index = 0; index < lines.length;) {
      const line = lines[index];
      const next = lines[index + 1] || '';
      const brokenHeader = line.includes('|') && next.includes('|') && /^[\s|:\-]+$/u.test(next)
        && (tableCells(line).length < 2 || tableCells(line).length !== tableCells(next).length
          || tableCells(next).some((cell) => !/^:?-{3,}:?$/u.test(cell)));
      if (!brokenHeader) {
        plain.push(line);
        index += 1;
        continue;
      }
      flush();
      const raw = [line, next];
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        raw.push(lines[index]);
        index += 1;
      }
      parts.push({ type: 'malformed-table', text: raw.join('\n') });
    }
    flush();
    return parts;
  }

  function renderMarkdown(source, options) {
    const renderer = new marked.Renderer();
    renderer.html = ({ text }) => escapeHtml(text);
    renderer.image = () => '<span class="answer-unsupported-media">图片内容尚未接通</span>';
    renderer.link = ({ href, title, tokens }) => {
      const label = marked.Parser.parseInline(tokens || [], { renderer });
      const safe = safeHref(href);
      return safe
        ? `<a href="${escapeHtml(safe)}"${title ? ` title="${escapeHtml(title)}"` : ''} target="_blank" rel="noopener noreferrer">${label}</a>`
        : label;
    };
    const tokens = marked.lexer(source, { gfm: true, breaks: true });
    const known = new Set((options.sourceIndexes || []).map(Number)
      .filter((index) => Number.isSafeInteger(index) && index > 0));
    if (known.size) stripKnownCitations(tokens, known);
    return marked.parser(tokens, { renderer, gfm: true, breaks: true });
  }

  function formatAnswerHtml(markdown, options = {}) {
    if (!marked || !purifier) throw new Error('Answer renderer dependencies are unavailable');
    const input = String(markdown ?? '').replace(/\r\n?/gu, '\n');
    if (!input.trim()) return '<p></p>';
    const rendered = partitionMalformedTables(input).map((part) => part.type === 'markdown'
      ? renderMarkdown(part.text, options)
      : `<div class="answer-table-fallback">${escapeHtml(part.text).replace(/\n/gu, '<br>')}</div>`).join('');
    const cleaned = purifier.sanitize(rendered, {
      ALLOWED_TAGS: allowedTags,
      ALLOWED_ATTR: ['href', 'title', 'target', 'rel', 'class', 'start', 'align'],
    });
    const container = root.document.createElement('div');
    container.innerHTML = cleaned;
    for (const table of container.querySelectorAll('table')) {
      table.classList.add('answer-table');
      const headings = [...table.querySelectorAll('thead th')].map((cell) => cell.textContent.trim());
      for (const row of table.querySelectorAll('tbody tr')) {
        [...row.children].forEach((cell, index) => {
          if (headings[index]) cell.setAttribute('data-label', headings[index]);
        });
      }
      const wrap = root.document.createElement('div');
      wrap.className = 'answer-table-wrap';
      table.replaceWith(wrap);
      wrap.append(table);
    }
    for (const block of container.querySelectorAll('pre')) block.classList.add('answer-code');
    return container.innerHTML;
  }

  function updateAnswerElement(element, markdown, options = {}) {
    const template = root.document.createElement('template');
    template.innerHTML = formatAnswerHtml(markdown, options);
    const next = [...template.content.children];
    const current = [...element.children];
    let stable = 0;
    while (stable < current.length && stable < next.length
      && current[stable].outerHTML === next[stable].outerHTML) stable += 1;
    for (let index = current.length - 1; index >= stable; index -= 1) current[index].remove();
    element.append(...next.slice(stable));
  }

  root.ImaAnswerRenderer = { formatAnswerHtml, updateAnswerElement };
})(globalThis);
