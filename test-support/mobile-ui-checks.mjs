import assert from 'node:assert/strict';

// The Page surface is just goto/evaluate/cdp. Locally this runs inside Ego Lite;
// CI uses the adapter in scripts/check-mobile-ui.mjs. Touches use native CDP input,
// not element.click(), so overlapping transparent targets fail this regression.
export async function runMobileUiChecks(page, baseUrl, paths = ['/', '/embed.html'], onProgress = () => {}) {
  const results = [];
  const evaluate = (fn, value) => value === undefined ? page.evaluate(fn) : page.evaluate(fn, value);
  // Background tabs throttle animation frames. Bound layout settling so local
  // browser acceptance does not wait seconds for every individual touch.
  const frames = () => evaluate(() => new Promise(resolve => {
    const timer = setTimeout(resolve, 50);
    requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); }));
  }));
  const tap = async point => {
    await page.cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await page.cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const close = async () => {
    await evaluate(() => { for (const animation of document.querySelector('.chat-citation-sheet').getAnimations()) animation.finish(); });
    const point = await evaluate(() => { const r = document.querySelector('.chat-card-close').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await tap(point); await frames();
    assert.equal(await evaluate(() => !!document.querySelector('.chat-citation-sheet')), false);
  };
  for (const path of paths) {
    await page.cdp('Page.bringToFront', {});
    await page.goto(`${baseUrl}${path}`);
    await evaluate(() => new Promise(resolve => { const check = () => window.mobileFixtureReady ? resolve() : setTimeout(check, 10); check(); }));
    await evaluate(() => { for (const animation of document.getAnimations()) animation.finish(); });
    for (const [width, height] of [[320, 640], [390, 844], [430, 932], [844, 390], [1024, 768]]) {
      await page.cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
      await page.cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
      await frames();
      // A desktop-to-mobile resize can start the sidebar slide transition.
      // Hit-test the settled responsive layout, rather than its moving overlay.
      await evaluate(() => { for (const animation of document.getAnimations()) animation.finish(); });
      assert.equal(await evaluate(() => matchMedia('(any-pointer: coarse)').matches), true);
      const count = await evaluate(() => document.querySelectorAll('[data-citation-key]').length);
      assert.equal(count, 19, 'fixture must include paragraph, wrapped, multiple-destination and table references');
      assert.equal(await evaluate(() => document.querySelectorAll('table [data-citation-key]').length), 6);
      // Check every occurrence and edge with the browser's real hit-test engine.
      const hitTests = await evaluate(() => [...document.querySelectorAll('[data-citation-key]')].flatMap((node, index) => {
        node.scrollIntoView({ block: 'center', inline: 'center' });
        const r = node.getBoundingClientRect(), label = node.querySelector('.chat-citation-label').getBoundingClientRect();
        return [{ x: label.left + label.width / 2, y: label.top + label.height / 2 },
          { x: r.left + 2, y: r.top + r.height / 2 }, { x: r.right - 2, y: r.top + r.height / 2 }].map(point => ({
          index, x: point.x, y: point.y, expected: node.dataset.citationKey, width: r.width, height: r.height,
          element: document.elementFromPoint(point.x, point.y)?.className,
          hit: document.elementFromPoint(point.x, point.y)?.closest('[data-citation-key]')?.dataset.citationKey }));
      }));
      for (const hit of hitTests) {
        assert.ok(hit.width >= 44 && hit.height >= 44, `${path} ${width}px target must reserve 44px`);
        assert.equal(hit.hit, hit.expected, `${path} ${width}px native hit-test mismatch: ${JSON.stringify(hit)}`);
      }
      // Native taps cover adjacent labels at every size. The 390px phone also
      // checks all first-row numbers, wrapped/table references, multiple
      // destinations and both edges. Keep this bounded for interactive browsers.
      const indexes = width === 390 ? [...new Set([0, 1, 2, 3, 4, 5, 6, 12, 13, count - 1])] : [0, 1];
      let nativeTaps = 0;
      for (const index of indexes) {
        for (const edge of width === 390 && index < 2 ? ['label', 'left', 'right'] : ['label']) {
          await evaluate(index => document.querySelectorAll('[data-citation-key]')[index].scrollIntoView({ block: 'center', inline: 'center' }), index);
          await frames();
          const geometry = await evaluate(({ index, edge }) => {
            const node = document.querySelectorAll('[data-citation-key]')[index];
            const r = node.getBoundingClientRect(), label = node.querySelector('.chat-citation-label').getBoundingClientRect();
            const x = edge === 'left' ? r.left + 2 : edge === 'right' ? r.right - 2 : label.left + label.width / 2;
            const y = edge === 'label' ? label.top + label.height / 2 : r.top + r.height / 2;
            return { x, y, width: r.width, height: r.height, expected: node.dataset.citationKey,
              hit: document.elementFromPoint(x, y)?.closest('[data-citation-key]')?.dataset.citationKey,
              urls: window.mobileFixture.citationMap[node.dataset.citationKey].sources.map(source => source.url), label: node.textContent };
          }, { index, edge });
          assert.ok(geometry.width >= 44 && geometry.height >= 44, `${path} ${width}px target ${index} must reserve 44px`);
          assert.equal(geometry.hit, geometry.expected, `${path} ${width}px ${index}/${edge} wrong native hit`);
          await tap({ x: geometry.x, y: geometry.y }); await frames();
          const opened = await evaluate(() => ({ urls: [...document.querySelectorAll('.chat-citation-sheet .chat-source-open')].map(a => a.href),
            title: document.querySelector('.chat-sheet-heading')?.textContent,
            draft: document.querySelector('textarea').value }));
          assert.deepEqual(opened.urls, geometry.urls, `${path} ${width}px ${index}/${edge} wrong source sheet`);
          assert.equal(opened.title, `网页来源 · ${geometry.label}`);
          assert.equal(opened.draft, '保留这份草稿');
          await close();
          nativeTaps++;
        }
      }
      assert.equal(await evaluate(() => document.querySelectorAll('.chat-citation-knowledge [data-citation-key], .chat-citation-knowledge a, .chat-citation-knowledge button').length), 0);
      results.push({ path, width, height, nativeTaps, hitTests: hitTests.length, exactSources: true });
      onProgress(results.at(-1));
    }
    // Short layout viewports emulate resize-on-keyboard browsers. Preserve
    // extra breathing room, input/send visibility and the final readable line.
    for (const [width, height] of [[320, 640], [390, 844], [430, 932], [390, 420]]) {
      await page.cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
      await frames();
      const layout = await evaluate(() => {
        const f = window.mobileFixture;
        f.log.scrollTop = f.log.scrollHeight;
        const form = document.querySelector('#askForm').getBoundingClientRect(), send = document.querySelector('#sendButton').getBoundingClientRect();
        return { gap: innerHeight - form.bottom, top: form.top, sendBottom: send.bottom, draft: f.input.value,
          safeAreaEnabled: document.querySelector('meta[name="viewport"]').content.includes('viewport-fit=cover') };
      });
      assert.ok(layout.gap >= 31.5, `${path} ${width}x${height} bottom gap ${layout.gap}`);
      assert.ok(layout.top >= 0 && layout.sendBottom <= height - 31.5);
      assert.equal(layout.safeAreaEnabled, true); assert.equal(layout.draft, '保留这份草稿');
      await frames();
      const visibleEnd = await evaluate(() => {
        const f = window.mobileFixture; f.log.scrollTop = f.log.scrollHeight;
        const last = f.answer.lastElementChild.getBoundingClientRect(), form = document.querySelector('#askForm').getBoundingClientRect();
        return last.bottom <= form.top;
      });
      assert.equal(visibleEnd, true, `${path} last answer line obscured`);
    }
    await page.cdp('Emulation.setTouchEmulationEnabled', { enabled: false });
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await frames();
    const point = await evaluate(() => {
      const a = document.querySelector('[data-citation-key]'); a.scrollIntoView({ block: 'center' });
      const r = a.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width };
    });
    assert.ok(point.width < 44, 'fine pointer retains compact markers');
    await page.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y }); await frames();
    assert.equal(await evaluate(() => !!document.querySelector('.chat-citation-card:not(.chat-citation-sheet)')), true);
    await evaluate(() => {
      window.componentPrevented = null;
      document.addEventListener('click', event => { if (!event.target.closest('[data-citation-key]')) return;
        window.componentPrevented = event.defaultPrevented; event.preventDefault(); }, { once: true });
    });
    await page.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: point.x, y: point.y });
    await page.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: point.x, y: point.y });
    assert.equal(await evaluate(() => window.componentPrevented), false, 'desktop single source preserves native link activation');
    await evaluate(() => window.ChatPresentation.closeCard());
  }
  await page.cdp('Emulation.setTouchEmulationEnabled', { enabled: false });
  await page.cdp('Emulation.clearDeviceMetricsOverride');
  return results;
}
