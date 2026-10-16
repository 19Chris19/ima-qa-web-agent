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
    await until(() => window.recoveryFixtureReady && [...document.querySelectorAll('.answer-retry')].some(button => button.textContent === '重试' && !button.disabled));
    const before = await page.evaluate(async () => ({ state: await (await fetch('/__test/state')).json(),
      draft: document.querySelector('textarea').value, retry: (() => {
        const r = [...document.querySelectorAll('.answer-retry')].find(button => button.textContent === '重试').getBoundingClientRect();
        const x = r.x + r.width / 2, y = r.y + r.height / 2;
        return { x, y, height: r.height, hitRetry: document.elementFromPoint(x, y)?.closest('button')?.classList.contains('answer-retry') };
      })() }));
    assert.ok(before.retry.height >= 44);
    assert.equal(before.retry.hitRetry, true, 'the failure retry must be visible and not covered by the composer');
    await page.cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: before.retry.x, y: before.retry.y }] });
    await page.cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
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
    return { pathname, touchRetry: true, draftPreserved: true, originalFailureKept: true, bottomGap: after.gap, transparentGap: true, realProviderCalls: 0 };
  } finally {
    await page.cdp('Emulation.setTouchEmulationEnabled', { enabled: false });
    await page.cdp('Emulation.clearDeviceMetricsOverride');
  }
}
