'use strict';

const { chromium } = require('playwright-core');
const { createHash } = require('node:crypto');
const {
  observeImaClientIdentity,
  requireImaClientIdentity,
} = require('./ima-client-identity');

const IMA_WEB_BASE_URL = 'https://ima.qq.com';
const DEFAULT_CONTEXT_MAX_AGE_MS = 15_000;
const DEFAULT_CAPTURE_TIMEOUT_MS = 25_000;

class IMAFirstPartyClientContextProvider {
  constructor(options = {}) {
    this.browserPath = String(options.browserPath || '').trim();
    this.maxAgeMs = boundedInteger(
      options.maxAgeMs,
      DEFAULT_CONTEXT_MAX_AGE_MS,
      1_000,
      60_000,
    );
    this.captureTimeoutMs = boundedInteger(
      options.captureTimeoutMs,
      DEFAULT_CAPTURE_TIMEOUT_MS,
      5_000,
      60_000,
    );
    this.capture = options.capture || captureFirstPartyClientContext;
    this.now = options.now || Date.now;
    this.cached = null;
    this.inflight = null;
    this.accountContexts = new Map();
  }

  async get(account, options = {}) {
    options.signal?.throwIfAborted();
    const key = createHash('sha256').update(JSON.stringify([account.id, account.principalFingerprint, account.headers])).digest('hex');
    const previous = this.accountContexts.get(key);
    if (previous?.cached && previous.cached.expiresAt > this.now()) return previous.cached.value;
    // A caller-owned abort must not cancel another task sharing the account.
    if (previous?.inflight && previous.signal === options.signal) return previous.inflight;
    const entry = { signal: options.signal };
    const pending = Promise.resolve(this.capture({
      account,
      browserPath: this.browserPath,
      timeoutMs: this.captureTimeoutMs,
      signal: options.signal,
    }))
      .then((value) => normalizeFirstPartyClientContext(value))
      .then((value) => {
        options.signal?.throwIfAborted();
        this.cached = { value, expiresAt: this.now() + this.maxAgeMs };
        entry.cached = this.cached;
        return value;
      })
      .finally(() => {
        entry.inflight = null;
        if (this.inflight === pending) this.inflight = null;
      });
    entry.inflight = pending;
    this.accountContexts.set(key, entry);
    while (this.accountContexts.size > 64) this.accountContexts.delete(this.accountContexts.keys().next().value);
    this.inflight = pending;
    return pending;
  }

  invalidate() {
    this.cached = null;
    this.accountContexts.clear();
  }

  summary() {
    return Object.freeze({
      schema_version: 'ima.first-party-client-context.summary.v1',
      ready: Boolean(this.cached && this.cached.expiresAt > this.now()),
      refreshing: Boolean(this.inflight),
    });
  }
}

async function captureFirstPartyClientContext(options = {}) {
  options.signal?.throwIfAborted();
  const account = options.account || {};
  const cookie = parseCookieHeader(account.headers?.['x-ima-cookie'] || account.headers?.cookie || '');
  const auth = firstPartyAccountInfo(cookie, account);
  if (!options.browserPath) throw contextError('ima_client_context_browser_unavailable');

  const browser = await chromium.launch({
    headless: true,
    executablePath: options.browserPath,
    timeout: options.timeoutMs,
    args: ['--no-first-run', '--no-default-browser-check'],
  });
  const abort = () => { void browser.close().catch(() => {}); };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    options.signal?.throwIfAborted();
    const context = await browser.newContext();
    const identityObserver = observeImaClientIdentity(context);
    const page = await context.newPage();
    await page.addInitScript(({ accountInfo }) => {
      localStorage.setItem(
        'ima-universal-local-storage-accountInfo',
        JSON.stringify(accountInfo),
      );
    }, { accountInfo: auth });

    let unexpectedQa = false;
    await page.route('**/cgi-bin/assistant/qa', async (route) => {
      unexpectedQa = true;
      await route.abort('blockedbyclient');
    });

    await page.goto(IMA_WEB_BASE_URL, {
      waitUntil: 'domcontentloaded',
      timeout: options.timeoutMs,
    });
    const qimeiResource = await page.waitForFunction(
      () => performance.getEntriesByType('resource')
        .map((entry) => entry.name)
        .find((name) => /\/qimeisdk-[A-Za-z0-9_-]+\.js$/u.test(name)) || '',
      null,
      { timeout: options.timeoutMs },
    );
    const qimeiUrl = String(await qimeiResource.jsonValue());
    assertQimeiResource(qimeiUrl);
    const value = await page.evaluate(async ({ moduleUrl }) => {
      const qimeiModule = await import(moduleUrl);
      const qimei = new qimeiModule.default({
        appKey: '0WEB0698R9XOG65A',
        disableDebugger: true,
        disableConsoleDetection: true,
      });
      const { h38 } = await qimei.getQimei36();
      const busInput = `${h38}_${Date.now()}`;
      return {
        q36: h38,
        userAgent: navigator.userAgent,
        deviceInfo: {
          uskey: qimei.getUSKeySync('7800236', h38, busInput),
          uskey_bus_infos_input: busInput,
        },
      };
    }, { moduleUrl: qimeiUrl });
    if (unexpectedQa) throw contextError('ima_client_context_unexpected_qa');
    const identity = await waitForObservedIdentity(identityObserver, options.timeoutMs);
    identityObserver.close();
    if (
      identity['IMA-Q36'] !== value.q36
      || identity['IMA-GUID'] !== `guid-${value.q36}`
      || identity['IMA-IUA'] !== value.userAgent.replace(/;/gu, ',')
    ) {
      throw contextError('ima_client_context_identity_mismatch');
    }
    options.signal?.throwIfAborted();
    return { identity, userAgent: value.userAgent, deviceInfo: value.deviceInfo };
  } finally {
    options.signal?.removeEventListener('abort', abort);
    await browser.close().catch(() => {});
  }
}

async function waitForObservedIdentity(observer, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return requireImaClientIdentity(observer.snapshot());
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  observer.close();
  throw contextError('ima_client_context_identity_timeout');
}

function assertQimeiResource(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw contextError('ima_client_context_capture_failed');
  }
  if (
    parsed.origin !== 'https://static.ima.qq.com'
    || !/\/qimeisdk-[A-Za-z0-9_-]+\.js$/u.test(parsed.pathname)
  ) {
    throw contextError('ima_client_context_capture_failed');
  }
}

function normalizeFirstPartyClientContext(value) {
  const identity = requireImaClientIdentity(value?.identity);
  const userAgent = boundedText(value?.userAgent, 512);
  const uskey = boundedOpaqueToken(value?.deviceInfo?.uskey, 4_096);
  const busInput = boundedText(value?.deviceInfo?.uskey_bus_infos_input, 256);
  if (
    !userAgent
    || identity['IMA-IUA'] !== userAgent.replace(/;/gu, ',')
    || !uskey
    || !busInput
  ) throw contextError('ima_client_context_invalid');
  return Object.freeze({
    identity,
    userAgent,
    deviceInfo: Object.freeze({
      uskey,
      uskey_bus_infos_input: busInput,
    }),
  });
}

function firstPartyAccountInfo(cookie, account) {
  const userId = boundedText(cookie['IMA-UID'], 256);
  const token = boundedText(cookie['IMA-TOKEN'], 8_192);
  const refreshToken = boundedText(cookie['IMA-REFRESH-TOKEN'], 8_192);
  if (!userId || !token || !refreshToken) {
    throw contextError('ima_client_context_auth_unavailable');
  }
  const tokenType = Number(cookie['TOKEN-TYPE'] || 0);
  const tokenExpiredTime = Number(account.tokenExpiresAt || 0) || undefined;
  const refreshTokenExpiredTime = Number(account.refreshTokenExpiresAt || 0) || undefined;
  return Object.freeze({
    userId,
    token,
    refreshToken,
    tokenType,
    idType: Number(cookie['UID-TYPE'] || 1),
    tokenExpiredTime,
    refreshTokenExpiredTime,
  });
}

function parseCookieHeader(value) {
  return Object.fromEntries(String(value || '').split(';').flatMap((part) => {
    const [rawKey, ...rawValue] = part.trim().split('=');
    const key = String(rawKey || '').trim();
    return key ? [[key, rawValue.join('=').trim()]] : [];
  }));
}

function boundedText(value, limit) {
  const text = String(value || '').trim();
  if (!text || text.length > limit || /[\u0000-\u001f\u007f]/u.test(text)) return '';
  return text;
}

function boundedOpaqueToken(value, limit) {
  return typeof value === 'string' && value.length > 0 && value.length <= limit ? value : '';
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value || fallback);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

function contextError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

module.exports = {
  IMAFirstPartyClientContextProvider,
  captureFirstPartyClientContext,
  normalizeFirstPartyClientContext,
};
