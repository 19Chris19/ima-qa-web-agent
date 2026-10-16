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
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10a9 9 0 1 1 2.6 8.4M3 4v6h6"/></svg><span></span>';
    const status = doc.createElement('span'); status.className = 'retry-status'; status.setAttribute('role', 'status');
    let pending = false, consumed = false;
    const refresh = () => {
      button.disabled = pending || consumed || disabled();
      button.setAttribute('aria-busy', String(pending));
      const text = label(pending ? 'pending' : consumed ? 'sent' : 'ready');
      button.querySelector('span').textContent = text;
      button.title = text; button.setAttribute('aria-label', text);
    };
    button.addEventListener('click', async () => {
      if (pending || consumed || disabled()) return;
      pending = true; status.textContent = ''; refresh();
      try { consumed = await run() === true; }
      catch (error) { status.textContent = onError(error) || ''; }
      finally { pending = false; refresh(); }
    });
    host.append(button, status); refresh();
    return { refresh, button };
  }

  root.ChatControls = { latest, retry };
})(typeof window === 'undefined' ? globalThis : window);
