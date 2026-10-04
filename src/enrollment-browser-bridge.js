const { chromium } = require('playwright-core');

function validateEndpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('扫码助手地址无效'); }
  if (url.protocol !== 'ws:' || !['127.0.0.1', 'host.docker.internal'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash
    || !/^\/[a-f0-9]{64}$/.test(url.pathname) || !url.port) {
    throw new Error('扫码助手只允许私有本机地址与独立连接密钥');
  }
  return url.href;
}

async function connectEnrollmentBrowser(endpoint, connect = (url) => chromium.connect(url, { timeout: 15000 })) {
  const url = validateEndpoint(endpoint);
  let browser;
  try {
    browser = await connect(url);
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const close = context.close.bind(context);
    context.close = async () => {
      try { await close(); } finally { await browser.close(); }
    };
    context.__imaEnrollmentBrowserVisible = true;
    return context;
  } catch {
    await browser?.close().catch(() => {});
    // Playwright errors contain endpoint credentials; never propagate them.
    throw new Error('本机扫码助手未连接，请启动维护机扫码助手后重试');
  }
}

module.exports = { validateEndpoint, connectEnrollmentBrowser };
