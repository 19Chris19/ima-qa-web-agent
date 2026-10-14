(function (root) {
  'use strict';
  const escape = value => String(value ?? '').replace(/&/gu, '&amp;').replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&#39;');
  const labels = { knowledge: '资料检索', web: '联网搜索', answer: '回答生成' };
  function webUrl(value) {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
        && !/(^|\.)ima\.qq\.com$/iu.test(url.hostname)
        && ![...url.searchParams.keys(), ...new URLSearchParams(url.hash.slice(1)).keys()]
          .some(key => /token|cookie|credential|secret|password|authorization|api[_-]?key|signature/iu.test(key)) ? url.href : '';
    } catch { return ''; }
  }
  function target(href) {
    const match = /^@(context|index)-ref\?([^\s]+)$/u.exec(String(href || ''));
    if (!match) return null;
    const params = new URLSearchParams(match[2]);
    const id = params.get('id');
    return id && id.length <= 128 ? `${match[1]}:${id}` : null;
  }
  function citation(token, options = {}) {
    const key = target(token.href);
    const isStatic = /^@(ref|para-ref)$/u.test(String(token.href));
    if (!key && !isStatic) return null;
    if (token.chatInMath || !/^\d{1,6}(?:,\d{1,6})*$/u.test(token.text || '')) return escape(token.raw || token.text);
    const entry = options.citationMap?.[key];
    const targets = entry?.type === 'web' ? [...new Set((entry.sources || []).map(source => webUrl(source?.url)).filter(Boolean))] : [];
    const previewable = targets.length > 0;
    const content = escape(token.text);
    const kind = ['web', 'knowledge'].includes(entry?.type) ? entry.type : 'unknown';
    const classes = `chat-citation chat-citation-${kind}`;
    if (!previewable) return `<sup class="${classes} chat-citation-static" aria-label="${kind === 'knowledge' ? '知识库引用' : '引用'} ${content}"><span class="chat-citation-mark">${content}</span></sup>`;
    if (targets.length === 1) return `<sup class="${classes}"><a class="chat-citation-mark chat-citation-link" href="${escape(targets[0])}" target="_blank" rel="noopener noreferrer" data-citation-key="${escape(key)}" aria-label="打开网页引用 ${content}（新标签页）" aria-haspopup="dialog" aria-expanded="false" title="悬停预览，点击打开网页">${content}</a></sup>`;
    // A reference may explicitly point to several pages. Never pick one by order.
    return `<sup class="${classes}"><button type="button" class="chat-citation-mark chat-citation-button" data-citation-key="${escape(key)}" aria-label="选择网页引用 ${content}（${targets.length} 个来源）" aria-haspopup="dialog" aria-expanded="false" title="此引用包含多个网页，请在预览卡片中选择">${content}</button></sup>`;
  }
  function protectMath(tokens, state = { math: '' }) {
    for (const token of tokens || []) {
      if (token.type === 'link' && state.math) token.chatInMath = true;
      if (token.type === 'text' && !token.tokens) {
        for (const match of String(token.raw || token.text).matchAll(/(?<!\\)(\$\$|\$)/gu)) {
          if (!state.math) state.math = match[1]; else if (state.math === match[1]) state.math = '';
        }
      }
      if (!['code', 'codespan', 'link', 'image'].includes(token.type)) {
        if (token.tokens) protectMath(token.tokens, state);
        for (const item of token.items || []) protectMath(item.tokens, state);
        for (const cell of [...(token.header || []), ...(token.rows || []).flat()]) protectMath(cell.tokens, state);
      }
    }
  }
  const toolIcons = {
    copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    download: '<path d="M12 3v12m-5-5 5 5 5-5M5 17v3h14v-3"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    error: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 4h.01"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
  };
  const toolActions = { 'copy-table': 'copy', csv: 'download', 'copy-code': 'copy', 'close-citation': 'close' };
  const feedbackTimers = new WeakMap();
  function setToolIcon(node, icon) {
    node.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${toolIcons[icon]}</svg>`;
  }
  function button(document, action, label, disabled = false) {
    const node = document.createElement('button');
    node.type = 'button'; node.className = 'chat-tool'; node.dataset.chatAction = action;
    node.title = label; node.setAttribute('aria-label', label); node.disabled = disabled;
    if (toolActions[action]) {
      node.classList.add('chat-tool-icon'); node.dataset.chatLabel = label;
      setToolIcon(node, toolActions[action]);
    } else node.textContent = label;
    return node;
  }
  function showToolFeedback(node, success) {
    const action = node.dataset.chatAction;
    const label = success ? action === 'csv' ? '表格已下载' : action === 'copy-table' ? '表格已复制' : '代码已复制'
      : action === 'csv' ? '下载失败，请重试' : '复制失败，请重试';
    root.clearTimeout(feedbackTimers.get(node));
    setToolIcon(node, success ? 'check' : 'error');
    node.classList.toggle('is-success', success); node.classList.toggle('is-error', !success);
    node.title = label; node.setAttribute('aria-label', label);
    feedbackTimers.set(node, root.setTimeout(() => {
      setToolIcon(node, toolActions[action]);
      node.classList.remove('is-success', 'is-error');
      node.title = node.dataset.chatLabel; node.setAttribute('aria-label', node.dataset.chatLabel);
      feedbackTimers.delete(node);
    }, 1500));
  }
  function validTable(table) {
    const width = table.querySelectorAll('thead tr:first-child th').length;
    const rows = [...table.querySelectorAll('tbody tr')];
    return width > 0 && rows.length > 0 && rows.every(row => row.children.length === width);
  }
  function decorate(container, options = {}) {
    const document = container.ownerDocument;
    const busy = options.streaming === true || options.answerComplete === false;
    for (const wrap of container.querySelectorAll('.answer-table-wrap')) {
      const table = wrap.querySelector('table');
      const tools = document.createElement('div'); tools.className = 'chat-table-tools';
      const disabled = busy || !validTable(table);
      tools.append(button(document, 'copy-table', '复制表格', disabled), button(document, 'csv', '下载表格（CSV）', disabled));
      if (options.partial) {
        const note = document.createElement('span'); note.className = 'chat-partial'; note.textContent = '部分回答'; tools.append(note);
      }
      wrap.prepend(tools);
    }
    for (const pre of container.querySelectorAll('pre.answer-code')) {
      pre.prepend(button(document, 'copy-code', '复制代码', busy));
    }
  }
  function cleanTable(table) {
    const clone = table.cloneNode(true);
    clone.querySelectorAll('.chat-citation, button').forEach(node => node.remove());
    for (const node of [clone, ...clone.querySelectorAll('*')]) for (const attr of [...node.attributes]) node.removeAttribute(attr.name);
    return clone;
  }
  function tableRows(table) {
    return [...cleanTable(table).querySelectorAll('tr')].map(row => [...row.children]
      .map(cell => cell.innerHTML.replace(/<br\s*\/?\s*>/giu, '\n'))
      .map(html => { const cell = table.ownerDocument.createElement('div'); cell.innerHTML = html; return cell.textContent; }));
  }
  function spreadsheetCell(value) {
    const cell = String(value);
    return /^[\s\uFEFF]*[=+@-]/u.test(cell) && !/^-\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(cell.trim()) ? `'${cell}` : cell;
  }
  function csv(rows) {
    return '\uFEFF' + rows.map(row => row.map(value => `"${spreadsheetCell(value).replace(/"/gu, '""')}"`).join(',')).join('\r\n') + '\r\n';
  }
  function tsv(rows) {
    return rows.map(row => row.map(value => {
      const cell = spreadsheetCell(value);
      return /[\t\r\n"]/u.test(cell) ? `"${cell.replace(/"/gu, '""')}"` : cell;
    }).join('\t')).join('\r\n');
  }
  async function copyText(value) {
    if (root.navigator.clipboard?.writeText) return root.navigator.clipboard.writeText(value);
    throw new Error('clipboard unavailable');
  }
  async function copyTable(table) {
    const clone = cleanTable(table), rows = tableRows(table), plain = tsv(rows);
    [...clone.querySelectorAll('tr')].forEach((row, i) => [...row.children].forEach((cell, j) => {
      const safe = spreadsheetCell(rows[i][j]);
      if (safe !== rows[i][j]) cell.textContent = safe;
    }));
    if (root.ClipboardItem && root.navigator.clipboard?.write) {
      return root.navigator.clipboard.write([new root.ClipboardItem({
        'text/html': new root.Blob([clone.outerHTML], { type: 'text/html' }),
        'text/plain': new root.Blob([plain], { type: 'text/plain' }),
      })]);
    }
    // A copy event supplies both formats on older desktop browsers.
    const listener = event => { event.clipboardData.setData('text/html', clone.outerHTML);
      event.clipboardData.setData('text/plain', plain); event.preventDefault(); };
    root.document.addEventListener('copy', listener, { once: true });
    try { if (!root.document.execCommand('copy')) throw new Error('clipboard unavailable'); }
    finally { root.document.removeEventListener('copy', listener); }
  }

  const bound = new WeakSet();
  let card, anchor, closing, touchActivation, restoringFocus = false, backdrop, modal = false;
  let coverTimer, previewController, generation = 0, cleanup = [], loadingPreview = false;
  function narrow() { return root.matchMedia?.('(max-width: 640px)').matches === true; }
  function closeCard(restore = false) {
    clearTimeout(closing); clearTimeout(coverTimer); generation++;
    previewController?.abort(); previewController = null;
    for (const dispose of cleanup.splice(0)) dispose();
    const previous = anchor;
    previous?.setAttribute('aria-expanded', 'false'); previous?.removeAttribute('aria-controls');
    card?.remove(); backdrop?.remove(); card = null; backdrop = null; anchor = null; modal = false;
    if (restore && previous?.isConnected) {
      const focus = () => { restoringFocus = true; previous.focus({ preventScroll: true }); restoringFocus = false; };
      focus();
      root.requestAnimationFrame?.(() => {
        const document = previous.ownerDocument;
        if (previous.isConnected && !card && [document.body, previous].includes(document.activeElement)) focus();
      });
    }
  }
  function positionCard(trigger) {
    if (!card || modal) return;
    card.style.maxHeight = '';
    const rect = trigger.getBoundingClientRect();
    card.style.left = `${Math.max(8, Math.min(rect.left, root.innerWidth - card.offsetWidth - 8))}px`;
    const below = Math.max(0, root.innerHeight - rect.bottom - 8);
    const above = Math.max(0, rect.top - 8);
    const placeBelow = card.offsetHeight <= below || below >= above;
    card.style.maxHeight = `${Math.min(480, Math.max(80, placeBelow ? below : above))}px`;
    card.style.top = `${Math.max(8, placeBelow ? rect.bottom + 8 : rect.top - card.offsetHeight - 8)}px`;
  }
  function lockBackground(document) {
    const body = document.body, html = document.documentElement, y = root.scrollY || 0;
    const before = { overflow: body.style.overflow, position: body.style.position, top: body.style.top, width: body.style.width, htmlOverflow: html.style.overflow };
    body.style.overflow = 'hidden'; body.style.position = 'fixed'; body.style.top = `-${y}px`; body.style.width = '100%'; html.style.overflow = 'hidden';
    const inert = [...body.children].filter(node => node !== card && node !== backdrop).map(node => [node, node.inert]);
    for (const [node] of inert) node.inert = true;
    cleanup.push(() => {
      for (const [node, value] of inert) node.inert = value;
      for (const key of ['overflow', 'position', 'top', 'width']) body.style[key] = before[key];
      html.style.overflow = before.htmlOverflow;
      if (y) root.scrollTo(0, y);
    });
  }
  function bindHandle(handle) {
    let start = null, distance = 0;
    handle.addEventListener('pointerdown', event => {
      if (event.button && event.button !== 0) return;
      start = event.clientY; distance = 0; handle.setPointerCapture?.(event.pointerId);
    });
    handle.addEventListener('pointermove', event => {
      if (start === null || !card) return;
      distance = Math.max(0, event.clientY - start); card.style.transform = `translateY(${distance}px)`;
    });
    const end = () => { if (distance >= 64) closeCard(true); else if (card) card.style.transform = ''; start = null; distance = 0; };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', () => { start = null; distance = 0; if (card) card.style.transform = ''; });
    handle.addEventListener('click', event => { if (event.detail === 0) closeCard(true); });
  }
  async function loadCovers(options, rows, ticket) {
    if (loadingPreview || ticket !== generation || !card || typeof options.loadPreview !== 'function') return;
    loadingPreview = true;
    previewController = new root.AbortController();
    const controller = previewController;
    try {
      for (const row of rows) {
        const { source, open } = row;
        if (ticket !== generation || controller.signal.aborted) break;
        const rect = open.getBoundingClientRect(), bounds = card.getBoundingClientRect();
        if (row.attempted || rect.bottom < bounds.top || rect.top > bounds.bottom || !/^[a-f0-9]{64}$/u.test(source.sourceId || '')) continue;
        row.attempted = true;
        const result = await options.loadPreview({ conversationId: options.conversationId, taskId: options.taskId,
          citationKey: anchor.dataset.citationKey, sourceId: source.sourceId }, controller.signal);
        if (!result?.blob) continue;
        const url = root.URL.createObjectURL(result.blob);
        if (ticket !== generation || controller.signal.aborted || !open.isConnected) { root.URL.revokeObjectURL(url); break; }
        cleanup.push(() => root.URL.revokeObjectURL(url));
        const frame = open.ownerDocument.createElement('div'); frame.className = 'chat-source-cover';
        const image = open.ownerDocument.createElement('img'); image.src = url; image.alt = '网页封面'; image.decoding = 'async'; image.referrerPolicy = 'no-referrer';
        image.addEventListener('error', () => frame.remove(), { once: true });
        frame.append(image); open.prepend(frame); positionCard(anchor);
      }
    } catch { /* Optional media never changes answer or source text. */ }
    finally { loadingPreview = false; if (previewController === controller) previewController = null; }
  }
  function showCard(trigger, options, sheet = false) {
    if (restoringFocus) return;
    const entry = options.citationMap?.[trigger.dataset.citationKey];
    const sources = entry?.type === 'web' ? (entry.sources || []).filter(source => webUrl(source.url)) : [];
    if (!sources.length) return;
    if (anchor === trigger && card?.isConnected && modal === sheet) { clearTimeout(closing); return; }
    closeCard(); anchor = trigger; modal = sheet;
    const document = trigger.ownerDocument, ticket = generation;
    card = document.createElement('div'); card.className = `chat-citation-card${sheet ? ' chat-citation-sheet' : ''}`; card.id = 'chat-citation-card';
    card.setAttribute('role', 'dialog'); card.setAttribute('aria-label', `网页引用 ${trigger.textContent}`);
    if (sheet) {
      card.setAttribute('aria-modal', 'true');
      backdrop = document.createElement('div'); backdrop.className = 'chat-citation-backdrop'; backdrop.setAttribute('aria-hidden', 'true');
      backdrop.addEventListener('click', () => closeCard(true)); document.body.append(backdrop);
      const handle = button(document, 'close-sheet', '下拉关闭来源面板'); handle.className = 'chat-sheet-handle';
      handle.replaceChildren(document.createElement('span')); bindHandle(handle); card.append(handle);
      const title = document.createElement('h2'); title.className = 'chat-sheet-heading'; title.textContent = `网页来源 · ${trigger.textContent}`; card.append(title);
    }
    const close = button(document, 'close-citation', '关闭引用'); close.classList.add('chat-card-close');
    close.addEventListener('click', () => closeCard(true)); card.append(close);
    const content = document.createElement('div'); content.className = 'chat-citation-sources';
    const rows = [];
    for (const source of sources) {
      const section = document.createElement('section');
      const open = document.createElement('a'); open.href = webUrl(source.url); open.target = '_blank';
      open.rel = 'noopener noreferrer'; open.className = 'chat-source-open';
      open.setAttribute('aria-label', `${source.title || '网页来源'}（新标签页打开）`);
      const title = document.createElement('strong'); title.className = 'chat-source-title'; title.textContent = source.title || '网页来源';
      const domain = document.createElement('small'); domain.className = 'chat-source-domain'; domain.textContent = new URL(webUrl(source.url)).hostname;
      const excerpt = document.createElement('p'); excerpt.className = 'chat-source-excerpt';
      excerpt.textContent = source.snippet || '该网页未提供内容摘录';
      if (!source.snippet) excerpt.classList.add('is-empty');
      open.append(title, domain, excerpt); section.append(open); content.append(section); rows.push({ source, open });
    }
    card.append(content); document.body.append(card);
    trigger.setAttribute('aria-expanded', 'true'); trigger.setAttribute('aria-controls', card.id);
    if (sheet) { lockBackground(document); close.focus({ preventScroll: true }); } else positionCard(trigger);
    card.addEventListener('focusout', event => { if (!modal && event.relatedTarget !== anchor && !card?.contains(event.relatedTarget)) closeCard(); });
    card.addEventListener('pointerenter', () => clearTimeout(closing));
    card.addEventListener('pointerleave', () => { if (!modal) closing = setTimeout(() => { if (!card?.contains(document.activeElement)) closeCard(); }, 180); });
    coverTimer = setTimeout(() => loadCovers(options, rows, ticket), sheet ? 0 : 300);
    // Scroll is a new explicit view of another card, not a background retry loop.
    content.addEventListener('scroll', () => {
      clearTimeout(coverTimer); coverTimer = setTimeout(() => loadCovers(options, rows.filter(row => !row.open.querySelector('img')), ticket), 300);
    }, { passive: true });
  }
  function bind(element, options = {}) {
    if (anchor && !anchor.isConnected) closeCard();
    if (anchor && element.contains(anchor) && card) {
      const key = anchor.dataset.citationKey;
      if (JSON.stringify(element.chatPresentation?.citationMap?.[key]) !== JSON.stringify(options.citationMap?.[key])) {
        const trigger = anchor, focused = card.contains(element.ownerDocument.activeElement), wasModal = modal;
        closeCard(); showCard(trigger, options, wasModal);
        if (focused) card?.querySelector('button, a')?.focus();
      }
    }
    element.chatPresentation = options;
    if (bound.has(element)) return;
    bound.add(element);
    element.addEventListener('pointerdown', event => {
      const trigger = event.target.closest?.('[data-citation-key]');
      touchActivation = trigger && ['touch', 'pen'].includes(event.pointerType)
        ? { trigger, at: root.performance.now() } : null;
    });
    element.addEventListener('pointercancel', () => { touchActivation = null; });
    element.addEventListener('pointerover', event => {
      if (modal || ['touch', 'pen'].includes(event.pointerType)) return;
      const trigger = event.target.closest?.('[data-citation-key]');
      if (trigger) showCard(trigger, element.chatPresentation);
    });
    element.addEventListener('pointerout', event => {
      if (modal) return;
      if (event.target.closest?.('[data-citation-key]') && !card?.contains(event.relatedTarget)) {
        closing = setTimeout(() => { if (anchor !== element.ownerDocument.activeElement && !card?.contains(element.ownerDocument.activeElement)) closeCard(); }, 180);
      }
    });
    element.addEventListener('focusin', event => {
      const trigger = event.target.closest?.('[data-citation-key]');
      if (trigger && !modal && touchActivation?.trigger !== trigger) showCard(trigger, element.chatPresentation, narrow());
    });
    element.addEventListener('focusout', event => {
      if (!modal && !card?.contains(event.relatedTarget) && !event.relatedTarget?.closest?.('[data-citation-key]')) closeCard();
    });
    element.addEventListener('keydown', event => {
      const trigger = event.target.closest?.('[data-citation-key]');
      if (trigger && ['ArrowDown', 'Tab'].includes(event.key) && !event.shiftKey && anchor === trigger && card) {
        event.preventDefault(); card.querySelector('button, a')?.focus();
      }
    });
    element.addEventListener('click', async event => {
      const trigger = event.target.closest?.('[data-citation-key]');
      if (trigger) {
        const entry = element.chatPresentation.citationMap?.[trigger.dataset.citationKey];
        const targets = entry?.type === 'web' ? [...new Set((entry.sources || []).map(source => webUrl(source?.url)).filter(Boolean))] : [];
        const activation = touchActivation; touchActivation = null;
        const touch = ['touch', 'pen'].includes(event.pointerType) || (!event.pointerType && event.detail !== 0
          && activation?.trigger === trigger && root.performance.now() - activation.at < 1000);
        if (trigger.tagName === 'A' && targets.length === 1 && trigger.href === targets[0] && !touch && !narrow()) {
          closeCard(); return;
        }
        event.preventDefault(); showCard(trigger, element.chatPresentation, touch || narrow());
        if (event.detail === 0 && !touch) card?.querySelector('button, a')?.focus(); return;
      }
      const control = event.target.closest?.('[data-chat-action]');
      if (!control || control.disabled) return;
      const action = control.dataset.chatAction;
      try {
        if (action === 'copy-code') await copyText(control.closest('pre').querySelector('code')?.textContent || '');
        else if (action === 'copy-table') await copyTable(control.closest('.answer-table-wrap').querySelector('table'));
        else if (action === 'csv') {
          const table = control.closest('.answer-table-wrap').querySelector('table');
          const url = root.URL.createObjectURL(new root.Blob([csv(tableRows(table))], { type: 'text/csv;charset=utf-8' }));
          const link = element.ownerDocument.createElement('a'); link.href = url; link.download = 'table.csv'; link.click();
          setTimeout(() => root.URL.revokeObjectURL(url), 1000);
        } else return;
        showToolFeedback(control, true);
      } catch { showToolFeedback(control, false); }
    });
  }
  function previewLoader(fetchImpl, base) {
    return async (reference, signal) => {
      if (!reference.conversationId || !reference.taskId || !reference.sourceId) return null;
      const query = new URLSearchParams(reference);
      const response = await fetchImpl(`${base}?${query}`, { signal });
      if (!response.ok || (await response.json()).status !== 'ready' || signal.aborted) return null;
      const image = await fetchImpl(`${base}/image?${query}`, { signal });
      const type = (image.headers.get('content-type') || '').split(';')[0];
      if (!image.ok || !['image/png', 'image/jpeg', 'image/webp'].includes(type)) { await image.body?.cancel(); return null; }
      const reader = image.body.getReader(), chunks = []; let size = 0;
      try {
        while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length;
          if (size > 512 * 1024) { await reader.cancel(); return null; } chunks.push(value); }
      } finally { reader.releaseLock(); }
      return { blob: new root.Blob(chunks, { type }) };
    };
  }
  function renderSuggestions(container, values, input, disabled = false) {
    const questions = [...new Set((Array.isArray(values) ? values : []).filter(value => typeof value === 'string' && value.trim() && value.length <= 2000))].slice(0, 3);
    let section = container.querySelector(':scope > .chat-suggestions');
    if (!questions.length) { section?.remove(); return; }
    if (!section) { section = container.ownerDocument.createElement('div'); section.className = 'chat-suggestions'; container.append(section); }
    if (section.dataset.questions !== JSON.stringify(questions)) {
      section.replaceChildren(); section.dataset.questions = JSON.stringify(questions);
      section.setAttribute('aria-label', '继续追问');
      for (const question of questions) {
        const control = button(container.ownerDocument, 'suggestion', question);
        control.addEventListener('click', () => {
          if (control.disabled || input.value.trim()) return;
          input.value = question; input.dispatchEvent(new root.Event('input', { bubbles: true })); input.focus();
        }); section.append(control);
      }
    }
    for (const control of section.querySelectorAll('button')) {
      control.disabled = disabled || Boolean(input.value.trim());
      control.title = input.value.trim() ? '请先处理输入框中的草稿' : '填入输入框，编辑后发送';
    }
  }
  function renderProcess(container, values, complete = false) {
    const steps = new Map();
    for (const step of values || []) {
      if (Object.hasOwn(labels, step?.phase) && ['running', 'completed', 'failed', 'cancelled'].includes(step.status)) steps.set(step.phase, step);
    }
    let details = container.querySelector(':scope > .chat-process');
    if (!steps.size) { details?.remove(); return; }
    if (!details) {
      details = container.ownerDocument.createElement('details'); details.className = 'chat-process';
      const summary = container.ownerDocument.createElement('summary'); summary.textContent = '回答过程';
      details.append(summary, container.ownerDocument.createElement('ol'));
      const body = container.querySelector(':scope > .message-content, :scope > .answer-markdown');
      if (body) body.before(details); else container.prepend(details);
    }
    if (complete && details.dataset.settled !== 'true') { details.open = false; details.dataset.settled = 'true'; }
    const list = details.querySelector('ol'); list.replaceChildren();
    for (const [phase, step] of steps) {
      const item = container.ownerDocument.createElement('li'); item.dataset.stepId = `chat:${phase}`;
      item.textContent = `${labels[phase]} · ${{ running: complete ? '已中断' : '进行中', completed: '已完成', failed: '未完成', cancelled: '已停止' }[step.status]}`;
      list.append(item);
    }
  }
  if (root.document) {
    root.document.addEventListener('pointerdown', event => { if (card && !modal && !card.contains(event.target) && !event.target.closest?.('[data-citation-key]')) closeCard(); });
    root.document.addEventListener('keydown', event => {
      if (!card) return;
      if (event.key === 'Escape') { event.preventDefault(); closeCard(true); return; }
      if (modal && event.key === 'Tab') {
        const focusable = [...card.querySelectorAll('button:not([disabled]), a[href]')], first = focusable[0], last = focusable.at(-1);
        if (!card.contains(root.document.activeElement) || (event.shiftKey && root.document.activeElement === first)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && root.document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    });
    root.document.addEventListener('focusin', event => { if (modal && card && !card.contains(event.target)) card.querySelector('.chat-card-close')?.focus(); });
    root.document.addEventListener('scroll', () => { if (anchor && !anchor.isConnected) closeCard(); }, true);
    root.addEventListener('resize', () => { if (anchor?.isConnected && card) positionCard(anchor); });
  }
  function stableHtml(element) {
    return element.outerHTML.replace(/ aria-controls="chat-citation-card"/gu, '')
      .replace(/ aria-expanded="true"/gu, ' aria-expanded="false"');
  }
  root.ChatPresentation = { stableHtml, citation, protectMath, decorate, bind, closeCard, renderSuggestions, renderProcess,
    webUrl, previewLoader, tableRows, csv, tsv, spreadsheetCell, copyTable };
})(globalThis);
