const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const { chromium } = require('playwright-core');

async function main() {
  const app = express();
  app.use(express.static(path.join(__dirname, '..', 'public')));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.TEST_BROWSER_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    const root = process.env.UI_SCREENSHOT_DIR;
    if (root) fs.mkdirSync(root, { recursive: true });
    const answer = '## Synthetic example\n\n| Device | Purpose |\n| --- | --- |\n| Camera | Capture |\n| GPU | Training |\n\n**Important**\n\n- First step\n- Second step\n\n```text\nsynthetic command\n```\n\n> Synthetic quotation\n';
    const conversation = { conversationId: 'synthetic-conversation', title: 'Synthetic question', turnCount: 1, updatedAt: new Date().toISOString() };
    for (const width of [1280, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      const page = await context.newPage();
      let verified = false;
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => localStorage.setItem('ima-qa-conversation-id', 'synthetic-conversation'));
      await page.route('**/api/**', route => {
        const url = new URL(route.request().url());
        let data;
        if (url.pathname.endsWith('/verify')) { verified = true; return route.fulfill({ json: { success: true, code: 'ok' } }); }
        if (url.pathname === '/api/conversations') data = { success: true, conversations: [conversation] };
        else if (url.pathname.startsWith('/api/conversations/')) data = { success: true, conversation, messages: [{ role: 'user', content: 'Synthetic question' }, { role: 'assistant', content: answer, sources: [{ index: 1, title: 'Synthetic source', snippet: 'Synthetic evidence' }] }] };
        else if (url.pathname === '/api/admin/bootstrap') data = { enrollment: { supportsAdminPageQr: true } };
        else data = { accounts: [{ id: 'synthetic', name: 'Synthetic account', status: 'available', availabilityStatus: 'ready', health: {} }], summary: { totalAccounts: 1, availableAccounts: 1 }, queue: { maxConcurrent: 1 } };
        if (url.pathname === '/api/admin/accounts') data.readiness = { mode: 'knowledge_agent', basicHealthy: 1, schedulable: verified ? 1 : 0, capacity: verified ? 1 : 0, pending: verified ? 0 : 1,
          accounts: [{ id: 'synthetic', state: verified ? 'ready' : 'pending', qualified: verified }] };
        return route.fulfill({ json: data });
      });
      await page.route('**/healthz', route => route.fulfill({ json: { ok: true, provider: 'ima-web-agent' } }));
      for (const surface of ['/', '/embed.html']) {
        await page.goto(`http://127.0.0.1:${server.address().port}${surface}`);
        await page.locator('#chatLog table').waitFor();
        assert.equal(await page.locator('#chatLog tbody tr').count(), 2);
        assert.equal(await page.locator('#chatLog strong').filter({ hasText: 'Important' }).count(), 1);
        assert.equal(await page.locator('#chatLog pre').count(), 1);
        assert.equal(await page.locator('#chatLog blockquote').count(), 1);
        assert.equal(await page.locator('#chatLog .sources').count(), 1);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await page.evaluate(() => Promise.all(document.getAnimations().filter(a => a.effect.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))));
        if (root) await page.screenshot({ path: path.join(root, `${surface === '/' ? 'main' : 'embed'}-${width}.png`), fullPage: true });
      }
      await page.goto(`http://127.0.0.1:${server.address().port}/admin.html`);
      await page.locator('#startEnrollmentButton').click();
      assert.equal(await page.locator('#exercisePanel').isVisible(), false);
      assert.equal(await page.locator('#adminLogin').isVisible(), false);
      assert.equal(await page.locator('#enrollmentDialog').evaluate(el => el.open), true);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#enrollmentDialog').evaluate(el => el.open), false);
      await page.getByRole('button', { name: '验证问答能力', exact: true }).click();
      await page.locator('#webActionQuestion').fill('Synthetic verification question');
      await page.locator('#webActionDialog button[type=submit]').click();
      await page.getByText('验证成功，可用于知识库问答', { exact: true }).waitFor();
      assert.ok((await page.locator('#webReadinessSummary').textContent()).includes('当前可调度 1'));
      if (root) await page.screenshot({ path: path.join(root, `admin-${width}.png`), fullPage: true });
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('Synthetic desktop/mobile: main, embed, history formatting, sources, admin dialog passed');
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
