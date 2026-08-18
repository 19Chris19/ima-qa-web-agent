(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ImaAnswerMarkdown = factory();
  }
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  const HTML_BREAK_MARKER = '\u0000ima-answer-break\u0000';
  const MAX_HEADING_TEXT_LENGTH = 48;

  function formatAnswerHtml(markdown, options = {}) {
    const text = normalizeMarkdownInput(markdown).trim();
    if (!text) {
      return '<p></p>';
    }

    const blocks = [];
    const lines = text.split('\n');
    let list = null;
    const flushList = () => {
      if (!list?.items.length) {
        list = null;
        return;
      }
      const tag = list.type === 'ordered' ? 'ol' : 'ul';
      const start = tag === 'ol' && list.start !== 1 ? ` start="${list.start}"` : '';
      blocks.push(`<${tag}${start}>${list.items.map((item) => `<li>${formatInline(item, options).replace(/\n/g, '<br>')}</li>`).join('')}</${tag}>`);
      list = null;
    };

    for (let index = 0; index < lines.length;) {
      const rawLine = lines[index];
      const line = rawLine.trim();
      if (!line) {
        flushList();
        index += 1;
        continue;
      }

      const codeBlock = parseCodeBlock(lines, index);
      if (codeBlock) {
        flushList();
        blocks.push(renderCodeBlock(codeBlock));
        index = codeBlock.nextIndex;
        continue;
      }

      const table = parseMarkdownTable(lines, index, options);
      if (table) {
        flushList();
        blocks.push(renderTable(table, options));
        index = table.nextIndex;
        continue;
      }

      const heading = /^(#{1,6})\s+(.+)$/.exec(line);
      if (heading) {
        flushList();
        const content = formatInline(heading[2], options);
        if (Array.from(heading[2].trim()).length <= MAX_HEADING_TEXT_LENGTH) {
          const level = Math.min(heading[1].length + 2, 4);
          blocks.push(`<h${level}>${content}</h${level}>`);
        } else {
          // IMA sometimes joins a heading and its following paragraph on one line.
          blocks.push(`<p>${content}</p>`);
        }
        index += 1;
        continue;
      }

      if (/^([-*_])\1\1+\s*$/.test(line)) {
        flushList();
        blocks.push('<hr />');
        index += 1;
        continue;
      }

      const quote = parseBlockQuote(lines, index);
      if (quote) {
        flushList();
        blocks.push(`<blockquote><p>${formatInline(quote.lines.join('\n'), options).replace(/\n/g, '<br>')}</p></blockquote>`);
        index = quote.nextIndex;
        continue;
      }

      const listItem = parseListItem(line);
      if (listItem) {
        if (!list || list.type !== listItem.type) {
          flushList();
          list = { type: listItem.type, start: listItem.start, items: [] };
        }
        list.items.push(listItem.content);
        index += 1;
        continue;
      }

      if (list && /^\s+/.test(rawLine)) {
        list.items[list.items.length - 1] += `\n${line}`;
        index += 1;
        continue;
      }

      if (isStreamingPendingBlockMarker(line, options)) {
        flushList();
        index += 1;
        continue;
      }

      const partialTableHeader = parsePartialTableHeader(line, options);
      if (partialTableHeader) {
        flushList();
        blocks.push(`<p class="answer-table-pending">${partialTableHeader.map((cell) => `<span>${formatInline(cell, options)}</span>`).join('')}</p>`);
        index += 1;
        continue;
      }

      flushList();
      const paragraphLines = [line];
      index += 1;
      while (index < lines.length && canJoinParagraph(lines, index, options)) {
        paragraphLines.push(lines[index].trim());
        index += 1;
      }
      blocks.push(`<p>${formatInline(paragraphLines.join('\n'), options).replace(/\n/g, '<br>')}</p>`);
    }
    flushList();
    return blocks.join('');
  }

  function normalizeMarkdownInput(markdown) {
    let text = String(markdown || '').replace(/\r\n?/g, '\n');
    text = text.replace(/<br\s*\/?>|&lt;br\s*\/?&gt;/gi, HTML_BREAK_MARKER);

    // IMA sometimes uses HTML breaks between Markdown table rows, while keeping
    // breaks inside a cell for readability. Preserve that distinction.
    const markerPattern = escapeRegExp(HTML_BREAK_MARKER);
    text = text
      .replace(new RegExp(`${markerPattern}\\s*(?=\\|)`, 'g'), '\n')
      .replace(new RegExp(`\\|\\s*${markerPattern}`, 'g'), '|\n')
      .replace(/([。！？!?])\s*(#{1,6})(?=\S)/g, '$1\n$2')
      .replace(/([^\s`])\s*```([a-z0-9+-]{0,32})\s*(?=\n|$)/gi, '$1\n```$2');
    text = text
      .split('\n')
      .map((line) => {
        if (line.includes('|')) {
          return line;
        }
        let normalizedLine = line.replace(
          new RegExp(`${markerPattern}\\s*(?=(?:#{1,6}(?=\\S)|>|[-*+]\\s|\\d+[.、]\\s|\`\`\`))`, 'g'),
          '\n',
        );
        if (/^\s*#{1,6}(?=\S)/.test(normalizedLine)) {
          normalizedLine = normalizedLine.replace(HTML_BREAK_MARKER, '\n');
        }
        return normalizedLine;
      })
      .join('\n')
      .replace(/(^|\n)(#{1,6})(?=[^\s#])/g, '$1$2 ');
    return text;
  }

  function canJoinParagraph(lines, index, options) {
    const line = String(lines[index] || '').trim();
    if (!line || parseCodeBlock(lines, index) || parseMarkdownTable(lines, index, options)) {
      return false;
    }
    return !/^(?:#{1,6}\s+|>|[-*+]\s+|\d+[.、]\s+|([-*_])\1\1+\s*$)/.test(line);
  }

  function parseCodeBlock(lines, startIndex) {
    const opening = /^\s*```\s*([^\s`]*)[^`]*$/.exec(String(lines[startIndex] || ''));
    if (!opening) {
      return null;
    }

    const content = [];
    let nextIndex = startIndex + 1;
    while (nextIndex < lines.length && !/^\s*```\s*$/.test(String(lines[nextIndex] || ''))) {
      content.push(String(lines[nextIndex] || ''));
      nextIndex += 1;
    }
    const closed = nextIndex < lines.length;
    return {
      content,
      language: normalizeLanguage(opening[1]),
      nextIndex: closed ? nextIndex + 1 : lines.length,
    };
  }

  function normalizeLanguage(value) {
    const language = String(value || '').trim().toLowerCase();
    return /^[a-z0-9+-]{1,32}$/.test(language) ? language : 'text';
  }

  function renderCodeBlock(block) {
    return `<pre class="answer-code"><code class="language-${block.language}">${escapeHtml(block.content.join('\n'))}</code></pre>`;
  }

  function parseBlockQuote(lines, startIndex) {
    const quoteLines = [];
    let nextIndex = startIndex;
    while (nextIndex < lines.length) {
      const match = /^\s*>\s?(.*)$/.exec(String(lines[nextIndex] || ''));
      if (!match) {
        break;
      }
      quoteLines.push(match[1]);
      nextIndex += 1;
    }
    return quoteLines.length ? { lines: quoteLines, nextIndex } : null;
  }

  function parseListItem(line) {
    const unordered = /^[-*+](?:\s+|(?=\*\*))(.+)$/.exec(line);
    if (unordered) {
      return { type: 'unordered', start: 1, content: unordered[1] };
    }
    const ordered = /^(\d+)[.、](?:\s+|(?=\*\*))(.+)$/.exec(line);
    if (ordered) {
      return { type: 'ordered', start: Number(ordered[1]), content: ordered[2] };
    }
    return null;
  }

  function parseMarkdownTable(lines, startIndex, options = {}) {
    const headerLine = String(lines[startIndex] || '').trim();
    const separatorLine = String(lines[startIndex + 1] || '').trim();
    if (!headerLine.includes('|') || !separatorLine.includes('|')) {
      return null;
    }

    const headers = splitTableRow(headerLine);
    const separators = splitTableRow(separatorLine);
    if (headers.length < 2) {
      return null;
    }

    const complete = separators.length === headers.length
      && separators.every((cell) => Boolean(parseAlignment(cell)));
    const preview = !complete && Boolean(options.streaming) && isTableSeparatorFragment(separators);
    if (!complete && !preview) {
      return null;
    }

    const normalizedSeparators = normalizeTableCells(separators, headers.length);
    const alignments = normalizedSeparators.map((cell) => parseAlignment(cell) || 'left');
    const rows = [];
    let hasPartialRow = false;
    let nextIndex = startIndex + 2;
    while (nextIndex < lines.length) {
      const line = String(lines[nextIndex] || '').trim();
      if (!line || !line.includes('|')) {
        break;
      }
      const cells = splitTableRow(line);
      if (cells.length < 2) {
        if (options.streaming && (line.startsWith('|') || line.endsWith('|'))) {
          rows.push(normalizeTableCells(cells, headers.length));
          hasPartialRow = true;
          nextIndex += 1;
        }
        break;
      }
      rows.push(normalizeTableCells(cells, headers.length));
      nextIndex += 1;
    }

    return { headers, alignments, rows, nextIndex, preview: preview || hasPartialRow };
  }

  function isTableSeparatorFragment(cells) {
    return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(String(cell || '').trim()));
  }

  function parsePartialTableHeader(line, options = {}) {
    if (!options.streaming || !line.includes('|') || (!line.startsWith('|') && !line.endsWith('|'))) {
      return null;
    }
    const cells = splitTableRow(line);
    return cells.length ? cells : null;
  }

  function isStreamingPendingBlockMarker(line, options = {}) {
    if (!options.streaming) {
      return false;
    }
    return /^(?:#{1,6}|>|[-*+]|\d+[.、]|`{1,2})$/.test(line);
  }

  function splitTableRow(line) {
    let value = String(line || '').trim();
    if (value.startsWith('|')) {
      value = value.slice(1);
    }
    if (value.endsWith('|') && !value.endsWith('\\|')) {
      value = value.slice(0, -1);
    }

    const cells = [];
    let cell = '';
    let inCode = false;
    for (let index = 0; index < value.length; index += 1) {
      const character = value[index];
      if (character === '\\' && value[index + 1] === '|') {
        cell += '|';
        index += 1;
        continue;
      }
      if (character === '`') {
        inCode = !inCode;
      }
      if (character === '|' && !inCode) {
        cells.push(cell.trim());
        cell = '';
        continue;
      }
      cell += character;
    }
    cells.push(cell.trim());
    return cells;
  }

  function parseAlignment(value) {
    const cell = String(value || '').trim();
    if (!/^:?-{3,}:?$/.test(cell)) {
      return '';
    }
    if (cell.startsWith(':') && cell.endsWith(':')) {
      return 'center';
    }
    if (cell.endsWith(':')) {
      return 'right';
    }
    return 'left';
  }

  function normalizeTableCells(cells, columnCount) {
    const normalized = cells.slice(0, columnCount);
    if (cells.length > columnCount) {
      normalized[columnCount - 1] = cells.slice(columnCount - 1).join(' | ');
    }
    while (normalized.length < columnCount) {
      normalized.push('');
    }
    return normalized;
  }

  function renderTable(table, options) {
    const tableClass = table.preview ? 'answer-table answer-table-preview' : 'answer-table';
    const header = table.headers
      .map((cell, index) => `<th class="align-${table.alignments[index]}">${formatInline(cell, options)}</th>`)
      .join('');
    const body = table.rows
      .map((row) => `<tr>${row
        .map((cell, index) => `<td data-label="${escapeAttribute(toPlainText(table.headers[index]))}" class="align-${table.alignments[index]}">${formatInline(cell, options)}</td>`)
        .join('')}</tr>`)
      .join('');
    return `<div class="answer-table-wrap"><table class="${tableClass}"><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  function formatInline(value, options = {}) {
    let source = hideDanglingMarkers(String(value || ''), options);
    const tokens = [];
    const stash = (html) => {
      const token = `\u0000ima-answer-${tokens.length}\u0000`;
      tokens.push(html);
      return token;
    };

    source = source
      .replace(/\[(\d+)\](?:\(@context-ref\?id=\d+\))?/g, (_match, index) => stash(`<sup class="citation">[${index}]</sup>`))
      .replace(/`([^`]+)`/g, (_match, code) => stash(`<code>${escapeHtml(code)}</code>`))
      .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g, (_match, label, href) => {
        const safeHref = sanitizeLinkHref(href);
        return safeHref
          ? stash(`<a href="${escapeAttribute(safeHref)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`)
          : escapeHtml(label);
      });

    let output = escapeHtml(source)
      .replace(/\*\*(\S(?:[\s\S]*?\S)?)\*\*/g, '<strong>$1</strong>')
      .replace(/~~(\S(?:[\s\S]*?\S)?)~~/g, '<del>$1</del>')
      .replace(/(^|[^\\w])\*([^*\n]+?)\*(?!\w)/g, '$1<em>$2</em>');

    output = output
      .replace(/\u0000ima-answer-(\d+)\u0000/g, (_match, index) => tokens[Number(index)] || '')
      .replace(new RegExp(escapeRegExp(HTML_BREAK_MARKER), 'g'), '<br>');
    return output;
  }

  function hideDanglingMarkers(value, options) {
    if (!options.streaming) {
      return value;
    }
    return ['**', '~~', '`'].reduce((result, marker) => {
      let count = 0;
      let offset = 0;
      let lastIndex = -1;
      while (true) {
        const index = result.indexOf(marker, offset);
        if (index === -1) {
          break;
        }
        count += 1;
        lastIndex = index;
        offset = index + marker.length;
      }
      return count % 2 === 1
        ? `${result.slice(0, lastIndex)}${result.slice(lastIndex + marker.length)}`
        : result;
    }, value);
  }

  function sanitizeLinkHref(value) {
    try {
      const url = new URL(String(value || '').trim());
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
    } catch {
      return '';
    }
  }

  function toPlainText(value) {
    return String(value || '').replace(/[\\`*_~]/g, '').trim();
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/`/g, '&#96;');
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  return {
    formatAnswerHtml,
    parseMarkdownTable,
  };
});
