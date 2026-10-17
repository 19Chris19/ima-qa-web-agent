import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

// Accepts an existing Ego Page or the CI adapter; never launches a browser.
export async function runRecoveryUiChecks(page, baseUrl, pathname = '/') {
  async function until(fn) {
    const deadline = performance.now() + 8000;
    while (performance.now() < deadline) { if (await page.evaluate(fn)) return; await delay(25); }
    const diagnostics = await page.evaluate(() => ({
      viewport: { width: innerWidth, height: innerHeight, scale: visualViewport?.scale },
      dialog: !!document.querySelector('.message-action-dialog[open]'),
      close: document.querySelector('.message-action-close')?.getBoundingClientRect().toJSON(),
      closeHit: window.recoveryCloseHit, inputs: window.recoveryInputAudit,
    }));
    throw Error(`Synthetic recovery page did not reach the expected state: ${JSON.stringify(diagnostics)}`);
  }
  await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.cdp('Emulation.setTouchEmulationEnabled', { enabled: true });
  await page.cdp('Page.bringToFront', {});
  try {
    await page.goto(baseUrl + pathname);
    // Some embedders reset device metrics on navigation. Test the actual viewport.
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page.cdp('Emulation.setTouchEmulationEnabled', { enabled: true });
    await until(() => window.recoveryFixtureReady && [...document.querySelectorAll('.answer-retry')].some(button => button.textContent === '重试' && !button.disabled));
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await Promise.allSettled(document.getAnimations().filter(animation => animation.effect.getComputedTiming().iterations !== Infinity).map(animation => animation.finished));
      const log = document.querySelector('#chatLog'); log.scrollTop = log.scrollHeight;
    });
    await page.evaluate(() => {
      // Test-only input diagnostics contain classes and coordinates, no message text.
      window.recoveryInputAudit = [];
      for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'click', 'contextmenu']) document.addEventListener(type, event => {
        window.recoveryInputAudit.push({ type, at: performance.now(), x: event.clientX, y: event.clientY, pointer: event.pointerType,
          target: event.target.closest?.('button')?.className || String(event.target.className), prevented: event.defaultPrevented, trusted: event.isTrusted });
        window.recoveryInputAudit = window.recoveryInputAudit.slice(-16);
      }, true);
    });
    const before = await page.evaluate(async () => ({ state: await (await fetch('/__test/state')).json(),
      draft: document.querySelector('textarea').value, retry: (() => {
        const r = [...document.querySelectorAll('.answer-retry')].find(button => button.textContent === '重试').getBoundingClientRect();
        const x = r.x + r.width / 2, y = r.y + r.height / 2;
        return { x, y, height: r.height, hitRetry: document.elementFromPoint(x, y)?.closest('button')?.classList.contains('answer-retry') };
      })() }));
    assert.ok(before.retry.height >= 44);
    assert.equal(before.retry.hitRetry, true, 'the failure retry must be visible and not covered by the composer');

    const touchGesture = async (point, duration = 0) => {
      // Linux headless synthetic tap gestures can omit compatibility clicks.
      // Use the same native touch sequence as the citation acceptance checks.
      // Interactive embedders may provide one timed native gesture to avoid
      // automation round-trip delays between the press and release.
      if (page.touchGesture) return page.touchGesture(point, duration);
      await page.cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
      if (duration) await delay(duration);
      await page.cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    const tap = point => touchGesture(point);
    const getUserPoint = () => page.evaluate(() => {
      const messages = [...document.querySelectorAll('.message.user')]; const message = messages.at(-1);
      const rect = message.querySelector('.message-actions-target').getBoundingClientRect();
      return { x: rect.left + 12, y: rect.top + 12 };
    });
    await tap(await getUserPoint());
    await delay(550);
    assert.equal(await page.evaluate(() => !!document.querySelector('.message-action-dialog[open]')), false, 'a normal tap does not open actions');
    const userPoint = await getUserPoint();
    // Generate the gesture in the browser so automation round trips cannot
    // accidentally turn its first touch into a one-second stationary hold.
    await page.cdp('Input.synthesizeScrollGesture', { x: userPoint.x, y: userPoint.y, yDistance: 120, speed: 600, gestureSourceType: 'touch' });
    await delay(550);
    assert.equal(await page.evaluate(() => !!document.querySelector('.message-action-dialog[open]')), false, 'scrolling cancels the hold');
    await page.evaluate(async () => {
      const log = document.querySelector('#chatLog'); log.scrollTop = log.scrollHeight; getSelection().removeAllRanges();
      // Drain the scroll event from this test reset before starting a hold.
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const holdPoint = await page.evaluate(() => { const r = [...document.querySelectorAll('.message.user .message-actions-target')].at(-1).getBoundingClientRect(); return { x: r.left + 12, y: r.top + 12 }; });
    await touchGesture(holdPoint, 560);
    await until(() => !!document.querySelector('.message-action-dialog[open]'));
    await page.evaluate(async () => { await Promise.allSettled(document.querySelector('.message-action-panel').getAnimations().map(animation => animation.finished)); });
    const menu = await page.evaluate(() => {
      const dialog = document.querySelector('.message-action-dialog'), panel = dialog.querySelector('.message-action-panel');
      const close = dialog.querySelector('.message-action-close').getBoundingClientRect();
      window.recoveryCloseHit = document.elementFromPoint(close.x+close.width/2, close.y+close.height/2)?.closest('button')?.className;
      return { sheet: dialog.dataset.sheet, bottom: panel.getBoundingClientRect().bottom, top: panel.getBoundingClientRect().top,
        action: dialog.querySelector('[data-action="retry"]').textContent, close: { x: close.x + close.width/2, y: close.y + close.height/2 },
        targets: [...dialog.querySelectorAll('button')].every(b => b.getBoundingClientRect().height >= 44) };
    });
    assert.equal(menu.sheet, 'true'); assert.equal(menu.action, '重试'); assert.ok(menu.top > 400 && menu.bottom <= 844); assert.equal(menu.targets, true);
    await tap(menu.close);
    await until(() => !document.querySelector('.message-action-dialog[open]'));
    assert.equal(await page.evaluate(() => document.activeElement === [...document.querySelectorAll('.message-actions-trigger')].at(-1)), true);
    const more = await page.evaluate(() => { const r = [...document.querySelectorAll('.message-actions-trigger')].at(-1).getBoundingClientRect(); return { x: r.x+r.width/2, y: r.y+r.height/2 }; });
    await tap(more); await until(() => !!document.querySelector('.message-action-dialog[open]'));
    await page.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await page.cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await until(() => !document.querySelector('.message-action-dialog[open]'));
    await tap(more); await until(() => !!document.querySelector('.message-action-dialog[open]'));
    await tap({x: 8, y: 90}); await until(() => !document.querySelector('.message-action-dialog[open]'));
    await tap(more); await until(() => !!document.querySelector('.message-action-dialog[open]'));
    const action = await page.evaluate(() => { const r = document.querySelector('.message-action-dialog [data-action="retry"]').getBoundingClientRect(); return { x:r.x+r.width/2, y:r.y+r.height/2 }; });
    await tap(action);
    // Race both entrances: the original answer icon shares the pending guard.
    await page.evaluate(() => document.querySelector('.answer-retry[aria-label="正在检查…"]')?.click());
    await until(() => [...document.querySelectorAll('.answer-retry')].filter(button => button.textContent === '再问一次' && !button.disabled).length >= 2);
    const after = await page.evaluate(async () => {
      const form = document.querySelector('#askForm'), log = document.querySelector('#chatLog'), wrap = document.querySelector('.composer-wrap');
      const hit = document.elementFromPoint(8, innerHeight - 4);
      const toolbar = [...document.querySelectorAll('.answer-tools')].reverse().find(node => node.querySelector('.answer-copy:not([hidden])') && node.querySelector('.answer-retry'));
      const copy = toolbar.querySelector('.answer-copy'), retry = toolbar.querySelector('.answer-retry');
      const read = node => {
        const style = getComputedStyle(node), icon = node.querySelector('svg'), shape = getComputedStyle(icon);
        return { width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height,
          color: style.color, background: style.backgroundColor, border: style.border, shadow: style.boxShadow,
          radius: style.borderRadius, iconSize: icon.getBoundingClientRect().width, stroke: shape.strokeWidth };
      };
      const copyStyle = read(copy), retryStyle = read(retry);
      const retryLeft = retry.getBoundingClientRect().left;
      const actionGap = retryLeft - copy.getBoundingClientRect().right;
      const feedback = toolbar.querySelector('.copy-status'), originalFeedback = feedback.textContent;
      feedback.textContent = '合成复制提示';
      const feedbackShift = retry.getBoundingClientRect().left - retryLeft;
      const feedbackAfterIcons = feedback.getBoundingClientRect().left >= retry.getBoundingClientRect().right;
      feedback.textContent = originalFeedback;
      return { toolbar: { copyStyle, retryStyle, actionGap, feedbackShift, feedbackAfterIcons },
        administrationInFrontend: document.body.classList.contains('app-page') ? !!document.querySelector('.admin-link, a[href="/admin"]') : false,
        state: await (await fetch('/__test/state')).json(), draft: document.querySelector('textarea').value,
        originalFailureKept: !!document.querySelector('.answer-failure, .message-error'),
        gap: innerHeight - form.getBoundingClientRect().bottom,
        wrapperBackground: getComputedStyle(wrap).backgroundColor, wrapperImage: getComputedStyle(wrap).backgroundImage,
        logBottom: log.getBoundingClientRect().bottom, gapPassesToLog: hit === log || log.contains(hit) };
    });
    assert.equal(after.state.submissions - before.state.submissions, 1);
    assert.equal(after.state.realProviderCalls, 0);
    assert.equal(after.draft, before.draft);
    assert.equal(after.originalFailureKept, true);
    assert.ok(after.gap >= 31.5);
    assert.equal(after.wrapperBackground, 'rgba(0, 0, 0, 0)'); assert.equal(after.wrapperImage, 'none');
    assert.ok(after.logBottom >= 843);
    assert.equal(after.gapPassesToLog, true);
    assert.equal(after.administrationInFrontend, false);
    assert.deepEqual(after.toolbar.copyStyle, after.toolbar.retryStyle, 'copy and retry must share dimensions, color, material and icon weight');
    assert.ok(after.toolbar.copyStyle.width >= 44 && after.toolbar.copyStyle.height >= 44);
    assert.equal(after.toolbar.copyStyle.iconSize, 18);
    assert.equal(after.toolbar.actionGap, 0, 'adjacent hit targets must be compact without overlapping');
    assert.equal(after.toolbar.feedbackShift, 0, 'copy feedback must not move the retry action');
    assert.equal(after.toolbar.feedbackAfterIcons, true);
    return { pathname, touchRetry: true, longPressRelease: true, scrollCancelsHold: true, closeAndFocus: true, escapeAndBackdrop: true, sharedRetryGuard: true, unifiedToolbar: true, feedbackStable: true, administrationSeparated: true, draftPreserved: true, originalFailureKept: true, bottomGap: after.gap, transparentGap: true, realProviderCalls: 0 };
  } finally {
    await page.cdp('Emulation.setTouchEmulationEnabled', { enabled: false });
    await page.cdp('Emulation.clearDeviceMetricsOverride');
  }
}
