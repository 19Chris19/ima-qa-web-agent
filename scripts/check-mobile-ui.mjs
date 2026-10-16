// CI-only headless adapter; local acceptance can reuse runMobileUiChecks with
// the user's existing Ego Lite Page, without launching another browser.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startMobileUiFixture } from '../test-support/mobile-ui-fixture.mjs';
import { runMobileUiChecks } from '../test-support/mobile-ui-checks.mjs';

const profile = await mkdtemp(join(tmpdir(), 'qa-mobile-ui-chrome-'));
const fixture = await startMobileUiFixture();
const chrome = spawn(process.env.CHROME_PATH || 'google-chrome', ['--headless=new', '--disable-gpu', '--no-first-run',
  '--no-default-browser-check', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
let chromeError, socket, sequence = 0;
const pending = new Map();
chrome.on('error', error => { chromeError = error.code || 'CHROME_START_FAILED'; });
try {
  let wsUrl;
  for (let attempt = 0; attempt < 200; attempt++) {
    if (chromeError) throw Error(`Chrome unavailable (${chromeError}); set CHROME_PATH to a Chromium executable`);
    try { const [port, path] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n'); wsUrl = `ws://127.0.0.1:${port}${path}`; break; } catch { await delay(25); }
  }
  if (!wsUrl) throw Error('Headless Chrome did not expose its loopback debugging endpoint');
  socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => {
    const reply = JSON.parse(event.data), waiter = pending.get(reply.id);
    if (!waiter) return;
    pending.delete(reply.id); clearTimeout(waiter.timer);
    if (reply.error) waiter.reject(Error(reply.error.message)); else waiter.resolve(reply.result);
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const cdp = (method, params) => send(method, params, sessionId);
  await cdp('Page.enable');
  const evaluate = async (fn, argument) => {
    const result = await cdp('Runtime.evaluate', { expression: `(${fn.toString()})(${JSON.stringify(argument) ?? 'undefined'})`, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.text);
    return result.result.value;
  };
  const page = { cdp, evaluate, goto: async url => {
    await cdp('Page.navigate', { url });
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await evaluate(() => window.mobileFixtureReady === true)) return;
      await delay(25);
    }
    throw Error('Local mobile UI fixture did not initialize');
  } };
  const isWebsite = (await readFile(new URL('../package.json', import.meta.url), 'utf8')).includes('explorer-ai-qa-demo');
  const result = await runMobileUiChecks(page, fixture.url, isWebsite ? ['/'] : ['/', '/embed.html']);
  console.log(JSON.stringify({ status: 'passed', nativeTouch: true, layouts: result, realProviderCalls: 0 }, null, 2));
} finally {
  for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(Error('Browser test ended')); }
  socket?.close(); chrome.kill();
  if (chrome.exitCode === null && !chromeError) await Promise.race([new Promise(resolve => chrome.once('exit', resolve)), delay(2000)]);
  if (chrome.exitCode === null && !chromeError) chrome.kill('SIGKILL');
  await fixture.close(); await rm(profile, { recursive: true, force: true });
}
