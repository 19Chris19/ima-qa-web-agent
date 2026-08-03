(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ImaAnswerMarkdown = factory();
  }
})(typeof globalThis === 'undefined' ? this : globalThis, function () {
  function formatAnswerHtml(markdown) {
    const text = String(markdown || '').trim();
    if (!text) {
      return '<p></p>';
    }

    const blocks = [];
    const lines = text.split(/\r?\n/);
    let listItems = [];
    const flushList = () => {
      if (listItems.length) {
        blocks.push(`<ul>${listItems.map((item) => `<li>${formatInline(item)}</li>`).join('')}</ul>`);
        listItems = [];
      }
    };

    for (let index = 0; index < lines.length;) {
      const rawLine = lines[index];
      const line = rawLine.trim();
      if (!line) {
        flushList();
        index += 1;
        continue;
      }

      const table = parseMarkdownTable(lines, index);
      if (table) {
        flushList();
        blocks.push(renderTable(table));
        index = table.nextIndex;
        continue;
      }

      const heading = /^(#{1,3})\s+(.+)$/.exec(line);
      if (heading) {
        flushList();
        const level = Math.min(heading[1].length + 2, 4);
        blocks.push(`<h${level}>${formatInline(heading[2])}</h${level}>`);
        index += 1;
        continue;
      }

      const list = /^(?:[-*]|\d+[.、])\s*(.+)$/.exec(line);
      if (list) {
        listItems.push(list[1]);
        index += 1;
        continue;
      }

      flushList();
      blocks.push(`<p>${formatInline(line)}</p>`);
      index += 1;
    }
    flushList();
    return blocks.join('');
  }

  function parseMarkdownTable(lines, startIndex) {
    const headerLine = String(lines[startIndex] || '').trim();
    const separatorLine = String(lines[startIndex + 1] || '').trim();
    if (!headerLine.includes('|') || !separatorLine.includes('|')) {
      return null;
    }

    const headers = splitTableRow(headerLine);
    const separators = splitTableRow(separatorLine);
    if (headers.length < 2 || separators.length !== headers.length) {
      return null;
    }

    const alignments = separators.map(parseAlignment);
    if (alignments.some((alignment) => !alignment)) {
      return null;
    }

    const rows = [];
    let nextIndex = startIndex + 2;
    while (nextIndex < lines.length) {
      const line = String(lines[nextIndex] || '').trim();
      if (!line || !line.includes('|')) {
        break;
      }
      const cells = splitTableRow(line);
      if (cells.length < 2) {
        break;
      }
      rows.push(normalizeTableCells(cells, headers.length));
      nextIndex += 1;
    }

    return { headers, alignments, rows, nextIndex };
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

  function renderTable(table) {
    const header = table.headers
      .map((cell, index) => `<th class="align-${table.alignments[index]}">${formatInline(cell)}</th>`)
      .join('');
    const body = table.rows
      .map((row) => `<tr>${row
        .map((cell, index) => `<td class="align-${table.alignments[index]}">${formatInline(cell)}</td>`)
        .join('')}</tr>`)
      .join('');
    return `<div class="answer-table-wrap"><table class="answer-table"><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  function formatInline(value) {
    return escapeHtml(value)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\[(\d+)\](?:\(@context-ref\?id=\d+\))?/g, '<sup class="citation">[$1]</sup>');
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
