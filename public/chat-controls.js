(function (root) {
  'use strict';

  // The same controller is shipped by the Provider and website. Reading intent
  // belongs to user input; resizing or a new answer must not steal the scroll.
  function latest({ log, button, following, setFollowing, hasContent = () => true }) {
    let visible = false, lastTop = log.scrollTop, inputUntil = 0, touchY = null;
    let frame = null, jumping = false;
    const gap = () => Math.max(0, log.scrollHeight - log.clientHeight - log.scrollTop);
    const now = () => root.performance.now();
    function refresh() {
      const distance = gap();
      visible = hasContent() && !following() && distance > (visible ? 48 : 120);
      button.dataset.visible = String(visible);
      button.setAttribute('aria-hidden', String(!visible));
      button.tabIndex = visible ? 0 : -1;
      if (!visible && root.document.activeElement === button) log.focus({ preventScroll: true });
    }
    function cancelJump() {
      if (frame !== null) root.cancelAnimationFrame(frame);
      frame = null; jumping = false;
    }
    function input(up = false) {
      inputUntil = now() + 1800;
      if (jumping || up) { cancelJump(); setFollowing(false); }
    }
    function pin() {
      if (following() && !jumping) {
        log.scrollTop = log.scrollHeight;
        lastTop = log.scrollTop;
      }
      refresh();
    }
    function jump({ animate = false } = {}) {
      cancelJump(); setFollowing(true); refresh();
      if (!animate || root.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { pin(); return; }
      const start = log.scrollTop, started = now();
      jumping = true;
      const step = () => {
        const progress = Math.min(1, (now() - started) / 220);
        // Resolve the destination each frame so streaming growth is included.
        const target = Math.max(0, log.scrollHeight - log.clientHeight);
        log.scrollTop = start + (target - start) * (1 - (1 - progress) ** 3);
        lastTop = log.scrollTop;
        if (progress < 1) frame = root.requestAnimationFrame(step);
        else { frame = null; jumping = false; pin(); }
      };
      frame = root.requestAnimationFrame(step);
    }
    button.hidden = false;
    button.classList.add('chat-latest-control');
    button.addEventListener('click', event => { jump({ animate: event.detail > 0 }); log.focus({ preventScroll: true }); });
    log.addEventListener('wheel', event => input(event.deltaY < 0), { passive: true });
    log.addEventListener('touchstart', event => { touchY = event.touches[0]?.clientY ?? null; }, { passive: true });
    log.addEventListener('touchmove', event => {
      const next = event.touches[0]?.clientY;
      if (Number.isFinite(next) && touchY !== null) input(next > touchY);
      touchY = next ?? null;
    }, { passive: true });
    log.addEventListener('pointerdown', () => input());
    log.addEventListener('pointermove', event => { if (event.buttons) input(); });
    log.addEventListener('keydown', event => {
      if (['TEXTAREA', 'INPUT'].includes(event.target.tagName) || event.target.isContentEditable) return;
      if (['ArrowUp', 'PageUp', 'Home', 'ArrowDown', 'PageDown', 'End', ' '].includes(event.key)) {
        input(['ArrowUp', 'PageUp', 'Home'].includes(event.key));
      }
    });
    log.addEventListener('scroll', () => {
      const direction = log.scrollTop - lastTop;
      lastTop = log.scrollTop;
      if (!jumping && now() <= inputUntil) {
        if (direction < -0.5) setFollowing(false);
        else if (direction >= 0 && gap() <= 48) setFollowing(true);
      }
      refresh();
    }, { passive: true });
    root.addEventListener('pagehide', cancelJump);
    if (root.ResizeObserver) new root.ResizeObserver(pin).observe(log);
    refresh();
    return { pin, refresh, jump, cancel: cancelJump };
  }

  function retry({ host, label, run, disabled = () => false, onError = () => {} }) {
    const doc = host.ownerDocument;
    const button = doc.createElement('button');
    button.type = 'button'; button.className = 'answer-retry';
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10a9 9 0 1 1 2.6 8.4M3 4v6h6"/></svg><span class="chat-control-label"></span>';
    const status = doc.createElement('span'); status.className = 'retry-status'; status.setAttribute('role', 'status');
    let pending = false, consumed = false, lastState = '';
    const listeners = new Set();
    const refresh = () => {
      button.disabled = pending || consumed || disabled();
      button.setAttribute('aria-busy', String(pending));
      const text = label(pending ? 'pending' : consumed ? 'sent' : 'ready');
      button.querySelector('span').textContent = text;
      button.title = text; button.setAttribute('aria-label', text);
      const next = `${button.disabled}/${pending}/${text}`;
      if (next !== lastState) { lastState = next; for (const listener of listeners) listener(); }
    };
    const invoke = async () => {
      if (pending || consumed || disabled()) return;
      pending = true; status.textContent = ''; refresh();
      try { consumed = await run() === true; }
      catch (error) { status.textContent = onError(error) || ''; }
      finally { pending = false; refresh(); }
    };
    button.addEventListener('click', invoke);
    host.append(button, status); refresh();
    return { refresh, button, invoke, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
  }



  // A concise outcome belongs to this answer, not to a blocking global alert.
  // Unknown outcomes are deliberately distinct from confirmed failures.
  function failure(host, { status = 'failed', hasAnswer = false, locale = 'zh', className = '', details = '' } = {}) {
    host.querySelector('.answer-outcome')?.remove();
    const note = host.ownerDocument.createElement('p');
    note.className = `answer-outcome ${className}`;
    note.dataset.outcome = status;
    note.setAttribute('role', 'status'); note.setAttribute('aria-atomic', 'true');
    const en = locale === 'en';
    note.textContent = status === 'indeterminate'
      ? en ? 'Result not yet confirmed. Check the original task.' : '结果尚无法确认，请先检查原任务。'
      : status === 'cancelled' ? en ? 'Answer stopped.' : '已停止回答。'
      : hasAnswer ? en ? 'Answer incomplete. Received text is kept.' : '回答未完成，已保留收到的内容。'
      : en ? 'Could not answer. Please retry.' : '暂时未能回答，请重试。';
    if (details) { const timing = host.ownerDocument.createElement('span'); timing.className = 'answer-outcome-time'; timing.textContent = ` · ${details}`; note.append(timing); }
    host.append(note);
    return note;
  }

  const actionServices = new WeakMap();
  function actionService(doc) {
    if (actionServices.has(doc)) return actionServices.get(doc);
    const win = doc.defaultView, bindings = new WeakMap();
    let hold = null, active = null, suppress = null;
    const selected = () => Boolean(win.getSelection()?.toString());
    function find(target) {
      const message = target?.closest?.('[data-message-actions]');
      return message && bindings.get(message);
    }
    function clearHold() { if (hold) win.clearTimeout(hold.timer); hold = null; }
    function close() {
      if (!active) return;
      const previous = active; active = null;
      previous.unsubscribe?.(); previous.observer?.disconnect();
      previous.binding.button.setAttribute('aria-expanded', 'false');
      if (previous.dialog.open && previous.dialog.close) previous.dialog.close();
      previous.dialog.remove();
      if (previous.binding.button.isConnected) previous.binding.button.focus({ preventScroll: true });
    }
    function open(binding) {
      clearHold(); close();
      if (!binding.message.isConnected) return;
      const labels = binding.labels();
      const dialog = doc.createElement('dialog'); dialog.className = 'message-action-dialog';
      dialog.setAttribute('aria-label', labels.title); dialog.setAttribute('aria-modal', 'true');
      const panel = doc.createElement('div'); panel.className = 'message-action-panel';
      const header = doc.createElement('div'); header.className = 'message-action-header';
      const title = doc.createElement('strong'); title.textContent = labels.title;
      const dismiss = doc.createElement('button'); dismiss.type = 'button'; dismiss.className = 'message-action-close';
      dismiss.setAttribute('aria-label', labels.close); dismiss.title = labels.close;
      dismiss.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m18 6-12 12M6 6l12 12"/></svg>';
      header.append(title, dismiss);
      const copy = doc.createElement('button'); copy.type = 'button'; copy.className = 'message-action-item'; copy.dataset.action = 'copy';
      copy.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2"/></svg><span></span>';
      copy.querySelector('span').textContent = labels.copy;
      const again = doc.createElement('button'); again.type = 'button'; again.className = 'message-action-item'; again.dataset.action = 'retry';
      again.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10a9 9 0 1 1 2.6 8.4M3 4v6h6"/></svg><span></span>';
      const caption = doc.createElement('p'); caption.className = 'message-action-caption';
      const feedback = doc.createElement('p'); feedback.className = 'message-action-feedback'; feedback.setAttribute('role', 'status');
      panel.append(header, copy, again, caption, feedback); dialog.append(panel); doc.body.append(dialog);
      const refresh = () => {
        const action = binding.action;
        action?.refresh(); again.hidden = !action;
        again.disabled = !action || action.button.disabled;
        again.querySelector('span').textContent = action?.button.getAttribute('aria-label') || '';
        caption.textContent = action ? binding.kind === 'recover' ? labels.recover : labels.retry : labels.copyOnly;
      };
      refresh();
      active = { dialog, binding, refresh, unsubscribe: binding.action?.subscribe(refresh) };
      // Disconnecting the conversation dismisses its menu. No per-message
      // global listeners or permanent observers survive a history rerender.
      active.observer = new win.MutationObserver(() => { if (!binding.message.isConnected) close(); });
      active.observer.observe(doc.body, { childList: true, subtree: true });
      const sheet = win.matchMedia?.('(max-width: 640px), (pointer: coarse)').matches;
      dialog.dataset.sheet = String(Boolean(sheet));
      if (!sheet) {
        const rect = binding.target.getBoundingClientRect();
        panel.style.left = `${Math.max(12, Math.min(win.innerWidth - 300, rect.right - 288))}px`;
        panel.style.top = `${Math.max(12, Math.min(win.innerHeight - 260, rect.bottom + 6))}px`;
      }
      binding.button.setAttribute('aria-expanded', 'true');
      if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', '');
      copy.focus({ preventScroll: true });
      dismiss.addEventListener('click', close);
      dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
      dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
      dialog.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); close(); }
        if (event.key !== 'Tab') return;
        const nodes = [...panel.querySelectorAll('button,textarea')].filter(node => !node.disabled && !node.hidden);
        const at = nodes.indexOf(doc.activeElement), next = (at + (event.shiftKey ? -1 : 1) + nodes.length) % nodes.length;
        event.preventDefault(); nodes[next].focus({ preventScroll: true });
      });
      again.addEventListener('click', () => {
        const action = binding.action;
        action?.refresh(); if (!action || action.button.disabled) return;
        // Both entrances use the exact same single-flight action and task ID.
        close(); void action.invoke();
      });
      let copying = false;
      copy.addEventListener('click', async () => {
        if (copying) return;
        copying = true; copy.disabled = true;
        try {
          await win.navigator.clipboard.writeText(binding.getText());
          if (active?.dialog === dialog) feedback.textContent = labels.copied;
        } catch {
          if (active?.dialog !== dialog) return;
          feedback.textContent = labels.select;
          let field = panel.querySelector('textarea');
          if (!field) { field = doc.createElement('textarea'); field.className = 'message-action-copytext'; field.readOnly = true; field.setAttribute('aria-label', labels.copy); panel.append(field); }
          field.value = binding.getText(); field.focus({ preventScroll: true }); field.select();
        } finally { copying = false; copy.disabled = false; }
      });
    }
    doc.addEventListener('pointerdown', event => {
      // A fresh press is intentional. Some touch browsers omit the hold's
      // compatibility click; never swallow the user's next backdrop tap.
      suppress = null;
      if (hold) { clearHold(); return; }
      const binding = find(event.target);
      if (!binding || event.pointerType !== 'touch' || event.isPrimary === false || selected()
          || event.target.closest('button,a,input,textarea')) return;
      const pending = { binding, x: event.clientX, y: event.clientY, id: event.pointerId };
      pending.timer = win.setTimeout(() => {
        if (hold !== pending) return;
        clearHold(); if (selected()) return;
        suppress = { binding, until: Date.now() + 1000 };
        open(binding);
      }, 500);
      hold = pending;
    }, true);
    doc.addEventListener('pointermove', event => {
      if (hold && (event.pointerId !== hold.id || Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > 8)) clearHold();
    }, { capture: true, passive: true });
    for (const type of ['pointerup', 'pointercancel', 'scroll']) doc.addEventListener(type, clearHold, true);
    doc.addEventListener('selectionchange', () => { if (selected()) clearHold(); });
    doc.addEventListener('click', event => {
      if (suppress && Date.now() < suppress.until && (find(event.target) === suppress.binding || event.target === active?.dialog)) {
        // Releasing the hold can retarget its compatibility click to the new
        // modal backdrop. Consume that release, not the next intentional tap.
        event.preventDefault(); event.stopPropagation(); suppress = null;
      } else suppress = null;
    }, true);
    doc.addEventListener('contextmenu', event => {
      const binding = find(event.target);
      if (!binding || selected() || event.target.closest('input,textarea')) return;
      event.preventDefault();
      if (active?.binding !== binding) open(binding);
    });
    win.addEventListener('pagehide', () => { clearHold(); close(); });
    const service = { bindings, open, close, update(binding) {
      if (active?.binding !== binding) return;
      active.unsubscribe?.(); active.unsubscribe = binding.action?.subscribe(active.refresh); active.refresh();
    } }; actionServices.set(doc, service); return service;
  }

  function messageActions({ message, target = message, getText, locale = () => 'zh' }) {
    const doc = message.ownerDocument, service = actionService(doc);
    if (service.bindings.has(message)) return service.bindings.get(message).control;
    const button = doc.createElement('button'); button.type = 'button'; button.className = 'message-actions-trigger';
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>';
    button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-expanded', 'false');
    const labels = () => locale() === 'en' ? {
      title: 'Message actions', close: 'Close', copy: 'Copy question', copied: 'Copied', select: 'Select the text below to copy.',
      retry: 'Checks the original task, then adds a new turn. Your draft and previous answers are kept.',
      recover: 'Checks the original task without sending the question again.', copyOnly: 'Copy this sent question.',
    } : {
      title: '消息操作', close: '关闭', copy: '复制问题', copied: '已复制', select: '请选择下方文字复制。',
      retry: '先核对原任务，再新增一轮。保留草稿和原回答。', recover: '检查原任务，不会重新发送问题。', copyOnly: '复制这条已发送的问题。',
    };
    const binding = { message, target, getText, button, labels, action: null, kind: '' };
    const refresh = () => { button.title = labels().title; button.setAttribute('aria-label', labels().title); };
    const control = { button, refresh, setAction(action, kind = 'retry') { binding.action = action; binding.kind = kind; service.update(binding); } };
    binding.control = control; service.bindings.set(message, binding);
    message.dataset.messageActions = ''; target.classList.add('message-actions-target');
    message.append(button); refresh();
    button.addEventListener('click', () => service.open(binding));
    return control;
  }

  root.ChatControls = { latest, retry, failure, messageActions };
})(typeof window === 'undefined' ? globalThis : window);
