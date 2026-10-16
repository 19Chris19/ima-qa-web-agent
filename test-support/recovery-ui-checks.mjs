import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

// Accepts an existing Ego Page or the CI adapter; never launches a browser.
export async function runRecoveryUiChecks(page, baseUrl, pathname = '/') {
  async function until(fn) {
    const deadline = performance.now() + 8000;
    while (performance.now() < deadline) { if (await page.evaluate(fn)) return; await delay(25); }
    throw Error('Synthetic recovery page did not reach the expected state');
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
    const before = await page.evaluate(async () => ({ state: await (await fetch('/__test/state')).json(),
      draft: document.querySelector('textarea').value, retry: (() => {
        const r = [...document.querySelectorAll('.answer-retry')].find(button => button.textContent === '重试').getBoundingClientRect();
        const x = r.x + r.width / 2, y = r.y + r.height / 2;
        return { x, y, height: r.height, hitRetry: document.elementFromPoint(x, y)?.closest('button')?.classList.contains('answer-retry') };
      })() }));
    assert.ok(before.retry.height >= 44);
    assert.equal(before.retry.hitRetry, true, 'the failure retry must be visible and not covered by the composer');

    const tap = point => page.cdp('Input.synthesizeTapGesture', { ...point, duration: 50, tapCount: 1, gestureSourceType: 'touch' });
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
    await page.cdp('Input.synthesizeTapGesture', { ...holdPoint, duration: 560, tapCount: 1, gestureSourceType: 'touch' });
    await until(() => !!document.querySelector('.message-action-dialog[open]'));
    await page.evaluate(async () => { await Promise.allSettled(document.querySelector('.message-action-panel').getAnimations().map(animation => animation.finished)); });
    const menu = await page.evaluate(() => {
      const dialog = document.querySelector('.message-action-dialog'), panel = dialog.querySelector('.message-action-panel');
      const close = dialog.querySelector('.message-action-close').getBoundingClientRect();
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
      return { state: await (await fetch('/__test/state')).json(), draft: document.querySelector('textarea').value,
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
    return { pathname, touchRetry: true, longPressRelease: true, scrollCancelsHold: true, closeAndFocus: true, escapeAndBackdrop: true, sharedRetryGuard: true, draftPreserved: true, originalFailureKept: true, bottomGap: after.gap, transparentGap: true, realProviderCalls: 0 };
  } finally {
    await page.cdp('Emulation.setTouchEmulationEnabled', { enabled: false });
    await page.cdp('Emulation.clearDeviceMetricsOverride');
  }
}
