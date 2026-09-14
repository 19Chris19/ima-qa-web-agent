const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parseIMAWebAgentStream, parseIMAWebAgentEvent, mapIMAWebAgentEvent, extractSources } = require('./ima-upstream-protocol');

const IMA_WEB_BASE_URL = 'https://ima.qq.com';
const INIT_SESSION_PATH = '/cgi-bin/session_logic/init_session';
const QA_PATH = '/cgi-bin/assistant/qa';
const REFRESH_PATH = '/cgi-bin/auth_login/refresh';
const WEB_VERSION = '999.999.999';
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

const ROBOT_TYPE_KNOWLEDGE = 5;
const QUESTION_TYPE_KNOWLEDGE = 2;
const COMMAND_TYPE_KNOWLEDGE_QA = 14;

class IMAWebAgentClient {
  constructor(config, fetchImpl = globalThis.fetch) {
    if (!fetchImpl) {
      throw new Error('A fetch implementation is required');
    }

    this.knowledgeBaseId = config.knowledgeBaseId;
    this.accountId = config.id || config.accountId || '';
    this.accountName = config.name || config.accountName || '';
    this.headers = normalizeAuthHeaders(config.headers);
    this.modelId = config.modelId;
    this.modelType = config.modelType;
    this.fetchImpl = fetchImpl;
    this.runtimeEnvPath = config.runtimeEnvPath || '';
    this.tokenExpiresAt = Number(config.tokenExpiresAt || 0) || null;
    this.refreshTokenExpiresAt = Number(config.refreshTokenExpiresAt || 0) || null;
    this.refreshSkewMs = Number(config.refreshSkewMs || 10 * 60 * 1000);
    this.refreshIntervalMs = Number(config.refreshIntervalMs || 60 * 1000);
    this.lastRefreshAt = null;
    this.lastRefreshError = '';
    this.refreshTimer = null;
    this.refreshPromise = null;
  }

  applyConfig(config = {}) {
    if (config.knowledgeBaseId) {
      this.knowledgeBaseId = config.knowledgeBaseId;
    }
    if (config.id || config.accountId) {
      this.accountId = config.id || config.accountId;
    }
    if (config.name || config.accountName) {
      this.accountName = config.name || config.accountName;
    }
    if (config.headers && typeof config.headers === 'object') {
      this.headers = normalizeAuthHeaders(config.headers);
    }
    if (config.modelId) {
      this.modelId = config.modelId;
    }
    if (Number.isFinite(Number(config.modelType))) {
      this.modelType = Number(config.modelType);
    }
    if (config.runtimeEnvPath !== undefined) {
      this.runtimeEnvPath = String(config.runtimeEnvPath || '');
    }
    if (Number.isFinite(Number(config.tokenExpiresAt))) {
      this.tokenExpiresAt = Number(config.tokenExpiresAt);
    }
    if (Number.isFinite(Number(config.refreshTokenExpiresAt))) {
      this.refreshTokenExpiresAt = Number(config.refreshTokenExpiresAt);
    }
    if (Number.isFinite(Number(config.refreshSkewMs))) {
      this.refreshSkewMs = Number(config.refreshSkewMs);
    }
    if (Number.isFinite(Number(config.refreshIntervalMs))) {
      this.refreshIntervalMs = Number(config.refreshIntervalMs);
    }
  }

  getConfigSnapshot() {
    return {
      id: this.accountId,
      name: this.accountName,
      knowledgeBaseId: this.knowledgeBaseId,
      headers: {
        'x-ima-cookie': this.headers['x-ima-cookie'] || this.headers.cookie || '',
        'x-ima-bkn': this.headers['x-ima-bkn'] || '',
      },
      modelId: this.modelId,
      modelType: this.modelType,
      runtimeEnvPath: this.runtimeEnvPath,
      tokenExpiresAt: this.tokenExpiresAt,
      refreshTokenExpiresAt: this.refreshTokenExpiresAt,
      refreshSkewMs: this.refreshSkewMs,
      refreshIntervalMs: this.refreshIntervalMs,
    };
  }

  async initSession(options = {}) {
    const clientContext = options.clientContext || this.createFirstPartyClientContext();
    const sessionOptions = { ...options, clientContext };
    let payload = await this._initSessionOnce(sessionOptions);
    let sessionId = payload.session_id || payload.session_info?.id;

    if (!sessionId && shouldRefreshAuth(payload) && options.allowAuthRefresh === false) {
      const error = new Error(payload.msg || 'IMA Web login expired');
      error.code = 'auth_expired';
      throw error;
    }

    if (!sessionId && shouldRefreshAuth(payload)) {
      await this.refreshAuth(sessionOptions);
      payload = await this._initSessionOnce(sessionOptions);
      sessionId = payload.session_id || payload.session_info?.id;
    }

    if (!sessionId) {
      throw new Error(payload.msg || 'IMA Web Agent init_session failed');
    }
    return sessionId;
  }

  createFirstPartyClientContext() {
    return Object.freeze({
      type: 'ima_web_first_party',
      origin: IMA_WEB_BASE_URL,
      referer: `${IMA_WEB_BASE_URL}/wikis?knowledgeBaseId=${encodeURIComponent(
        this.knowledgeBaseId,
      )}&isUseKnowledgeBaseQa=1`,
      fromBrowserIma: '1',
      userAgent: DEFAULT_USER_AGENT,
    });
  }

  async ensureFreshAuth(options = {}) {
    const now = Date.now();
    if (!this.tokenExpiresAt) {
      return false;
    }
    if (this.tokenExpiresAt - now > this.refreshSkewMs) {
      return false;
    }
    await this.refreshAuth(options);
    return true;
  }

  async _initSessionOnce(options = {}) {
    const response = await this.fetchImpl(`${IMA_WEB_BASE_URL}${INIT_SESSION_PATH}`, {
      method: 'POST',
      headers: this._headers(options.clientContext),
      body: JSON.stringify({
        envInfo: { robotType: ROBOT_TYPE_KNOWLEDGE, interactType: 0 },
        relatedUrl: this.knowledgeBaseId,
        sceneType: 1,
        msgsLimit: 10,
        forbidAutoAddToHistoryList: true,
        knowledgeBaseInfoWithFolder: {
          knowledgeBaseId: this.knowledgeBaseId,
          folderIds: [],
        },
      }),
      signal: options.signal,
    });

    return readJsonResponse(response, 'IMA init_session', { allowBusinessError: true });
  }

  async refreshAuth(options = {}) {
    if (this.refreshPromise) {
      await this.refreshPromise;
      return;
    }

    this.refreshPromise = this._refreshAuthOnce(options);
    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  async _refreshAuthOnce(options = {}) {
    const cookie = parseCookieHeader(this.headers['x-ima-cookie'] || this.headers.cookie || '');
    const refreshToken = cookie['IMA-REFRESH-TOKEN'];
    const userId = cookie['IMA-UID'];
    const tokenType = Number(cookie['TOKEN-TYPE'] || 0);

    if (!refreshToken || !userId) {
      throw new Error('IMA Web login expired and refresh credentials are unavailable');
    }

    const response = await this.fetchImpl(`${IMA_WEB_BASE_URL}${REFRESH_PATH}`, {
      method: 'POST',
      headers: {
        ...this._headers(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        user_id: userId,
        refresh_token: refreshToken,
        token_type: tokenType,
      }),
      signal: options.signal,
    });

    const payload = await readJsonResponse(response, 'IMA auth refresh');
    const data = payload.accountInfo || payload.account_info || payload.data || payload;
    const now = Date.now();
    const nextCookie = {
      ...cookie,
      'IMA-UID': String(data.userId || data.user_id || data.uid || userId),
      'IMA-TOKEN': String(data.token || data.imaToken || data.ima_token || cookie['IMA-TOKEN'] || ''),
      'IMA-REFRESH-TOKEN': String(data.refreshToken || data.refresh_token || refreshToken),
      'TOKEN-TYPE': String(data.tokenType || data.token_type || tokenType),
      'UID-TYPE': String(data.idType || data.id_type || cookie['UID-TYPE'] || '1'),
    };

    const cookieString = stringifyCookie(nextCookie);
    this.headers = {
      ...this.headers,
      'x-ima-cookie': cookieString,
      cookie: cookieString,
      'x-ima-bkn': String(getBkn(nextCookie['IMA-TOKEN'] || '')),
    };
    this.tokenExpiresAt = extractExpiryMs(data, [
      'tokenExpiredTime',
      'token_expired_time',
      'tokenExpireTime',
      'token_expire_time',
    ]) || (Number(data.tokenValidTime || data.token_valid_time || 0) > 0
      ? now + Number(data.tokenValidTime || data.token_valid_time) * 1000
      : this.tokenExpiresAt);
    this.refreshTokenExpiresAt = extractExpiryMs(data, [
      'refreshTokenExpiredTime',
      'refresh_token_expired_time',
      'refreshTokenExpireTime',
      'refresh_token_expire_time',
    ]) || (Number(data.refreshTokenValidTime || data.refresh_token_valid_time || 0) > 0
      ? now + Number(data.refreshTokenValidTime || data.refresh_token_valid_time) * 1000
      : this.refreshTokenExpiresAt);
    this.lastRefreshAt = now;
    this.lastRefreshError = '';
    this.persistRuntimeEnv();
  }

  async *streamAsk({ question, signal, sessionId: requestedSessionId, onSession } = {}) {
    await this.ensureFreshAuth({ signal });
    let activeSessionId = requestedSessionId || await this.initSession({ signal });
    onSession?.(activeSessionId);

    // Once dispatched, an interrupted question must not be asked again implicitly.
    yield* this._streamAskOnce({ question, signal, sessionId: activeSessionId });
  }

  async *_streamAskOnce({ question, signal, sessionId }) {
    const response = await this.fetchImpl(`${IMA_WEB_BASE_URL}${QA_PATH}`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify({
        session_id: sessionId,
        robot_type: ROBOT_TYPE_KNOWLEDGE,
        question,
        question_type: QUESTION_TYPE_KNOWLEDGE,
        client_id: crypto.randomUUID(),
        command_info: {
          type: COMMAND_TYPE_KNOWLEDGE_QA,
          knowledge_qa_info: {
            tags: [],
            knowledge_ids: [],
            media_id_infos: [],
          },
        },
        model_info: {
          model_id: this.modelId,
          model_type: Number(this.modelType),
          enable_enhancement: false,
        },
        history_info: {},
        client_tools: [],
      }),
      signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`IMA Web Agent returned HTTP ${response.status}: ${text.slice(0, 200)}`);
    }

    yield* parseIMAWebAgentStream(response);
  }

  _headers(clientContext) {
    const context = normalizeFirstPartyClientContext(clientContext, this.createFirstPartyClientContext());
    return {
      accept: '*/*',
      'content-type': 'application/json',
      'cache-control': 'no-cache',
      origin: context.origin,
      referer: context.referer,
      from_browser_ima: context.fromBrowserIma,
      extension_version: WEB_VERSION,
      'user-agent': context.userAgent,
      ...this.headers,
    };
  }

  startAutoRefresh() {
    this.stopAutoRefresh();
    if (!this.refreshIntervalMs || this.refreshIntervalMs <= 0) {
      return null;
    }

    this.refreshTimer = setInterval(() => {
      this.ensureFreshAuth().catch((error) => {
        this.lastRefreshError = error?.message || 'IMA Web auth refresh failed';
      });
    }, this.refreshIntervalMs);
    this.refreshTimer.unref?.();
    return this.refreshTimer;
  }

  stopAutoRefresh() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  getAuthStatus(now = Date.now()) {
    return {
      tokenExpiresAt: this.tokenExpiresAt ? new Date(this.tokenExpiresAt).toISOString() : null,
      refreshTokenExpiresAt: this.refreshTokenExpiresAt
        ? new Date(this.refreshTokenExpiresAt).toISOString()
        : null,
      tokenSecondsRemaining: this.tokenExpiresAt
        ? Math.max(0, Math.floor((this.tokenExpiresAt - now) / 1000))
        : null,
      refreshTokenSecondsRemaining: this.refreshTokenExpiresAt
        ? Math.max(0, Math.floor((this.refreshTokenExpiresAt - now) / 1000))
        : null,
      refreshSkewSeconds: Math.floor(this.refreshSkewMs / 1000),
      refreshIntervalSeconds: Math.floor(this.refreshIntervalMs / 1000),
      lastRefreshAt: this.lastRefreshAt ? new Date(this.lastRefreshAt).toISOString() : null,
      lastRefreshError: this.lastRefreshError || null,
      runtimePersistence: this.runtimeEnvPath ? 'enabled' : 'disabled',
    };
  }

  persistRuntimeEnv() {
    if (!this.runtimeEnvPath) {
      return false;
    }

    const envText = buildRuntimeEnvText({
      accountId: this.accountId || '',
      accountName: this.accountName || '',
      port: process.env.PORT || '',
      knowledgeBaseId: this.knowledgeBaseId,
      headers: {
        'x-ima-cookie': this.headers['x-ima-cookie'] || this.headers.cookie || '',
        'x-ima-bkn': this.headers['x-ima-bkn'] || '',
      },
      modelId: this.modelId,
      modelType: this.modelType,
      runtimeEnvPath: this.runtimeEnvPath,
      tokenExpiresAt: this.tokenExpiresAt,
      refreshTokenExpiresAt: this.refreshTokenExpiresAt,
      refreshSkewMs: this.refreshSkewMs,
      refreshIntervalMs: this.refreshIntervalMs,
    });

    const dir = path.dirname(this.runtimeEnvPath);
    const tempPath = path.join(
      dir,
      `.${path.basename(this.runtimeEnvPath)}.${process.pid}.${Date.now()}.tmp`,
    );

    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tempPath, envText, { mode: 0o600 });
    try {
      fs.chmodSync(tempPath, 0o600);
    } catch {
      // Best effort only; writeFileSync mode covers normal creation.
    }
    fs.renameSync(tempPath, this.runtimeEnvPath);
    try {
      fs.chmodSync(this.runtimeEnvPath, 0o600);
    } catch {
      // Best effort only; temp file mode covers normal writes.
    }
    return true;
  }
}

function normalizeAuthHeaders(headers) {
  if (!headers || typeof headers !== 'object') {
    return {};
  }
  if (headers.headers && typeof headers.headers === 'object') {
    return headers.headers;
  }
  return headers;
}

function normalizeFirstPartyClientContext(context, fallback) {
  const candidate = context && typeof context === 'object' ? context : fallback;
  if (
    candidate?.type !== 'ima_web_first_party' ||
    candidate.origin !== IMA_WEB_BASE_URL ||
    !String(candidate.referer || '').startsWith(`${IMA_WEB_BASE_URL}/`)
  ) {
    const error = new Error('IMA Web first-party client context is unavailable');
    error.code = 'web_context_missing';
    throw error;
  }
  return {
    origin: IMA_WEB_BASE_URL,
    referer: String(candidate.referer),
    fromBrowserIma: '1',
    userAgent: String(candidate.userAgent || DEFAULT_USER_AGENT),
  };
}

async function readJsonResponse(response, label, options = {}) {
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text || '{}');
  } catch {
    throw new Error(`${label} returned non-JSON response: ${text.slice(0, 200)}`);
  }

  if (!response.ok || (payload.code !== 0 && !options.allowBusinessError)) {
    throw new Error(payload.msg || `${label} failed`);
  }
  return payload;
}

function shouldRefreshAuth(payload) {
  const code = Number(payload?.code);
  const message = String(payload?.msg || '');
  return code === 41 || /登录失败|登录过期|token|鉴权|未登录/i.test(message);
}

function isSessionExpiredError(error) {
  return /session.?id|会话|上下文|登录过期|未登录|鉴权|401|403/i.test(
    String(error?.message || error || ''),
  );
}

function getBkn(token) {
  let hash = 5381;
  for (let index = 0; index < token.length; index += 1) {
    hash += (hash << 5) + token.charAt(index).charCodeAt(0);
  }
  return hash & 2147483647;
}

function parseCookieHeader(cookieHeader) {
  const cookie = {};
  for (const part of String(cookieHeader || '').split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=');
    const key = rawKey && rawKey.trim();
    if (!key) {
      continue;
    }
    cookie[key] = rawValue.join('=').trim();
  }
  return cookie;
}

function stringifyCookie(cookie) {
  return Object.entries(cookie)
    .map(([key, value]) => `${key}=${String(value == null ? '' : value).replace(/[;\r\n]/g, '')}`)
    .join('; ');
}

function extractExpiryMs(data, keys) {
  for (const key of keys) {
    const value = Number(data?.[key] || 0);
    if (value > 0) {
      return value < 10_000_000_000 ? value * 1000 : value;
    }
  }
  return null;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildRuntimeEnvText(options) {
  const lines = [];
  if (options.accountId) {
    lines.push(`IMA_WEB_AGENT_ACCOUNT_ID=${shellQuote(options.accountId)}`);
  }
  if (options.accountName) {
    lines.push(`IMA_WEB_AGENT_ACCOUNT_NAME=${shellQuote(options.accountName)}`);
  }
  if (options.port) {
    lines.push(`PORT=${shellQuote(options.port)}`);
  }
  lines.push('IMA_QA_PROVIDER=ima-web-agent');
  lines.push(`IMA_WEB_KNOWLEDGE_BASE_ID=${shellQuote(options.knowledgeBaseId)}`);
  lines.push(`IMA_WEB_AGENT_MODEL_ID=${shellQuote(options.modelId)}`);
  lines.push(`IMA_WEB_AGENT_MODEL_TYPE=${shellQuote(options.modelType)}`);
  lines.push(`IMA_WEB_AGENT_HEADERS_JSON=${shellQuote(JSON.stringify(options.headers))}`);
  if (options.runtimeEnvPath) {
    lines.push(`IMA_WEB_AGENT_RUNTIME_ENV_PATH=${shellQuote(options.runtimeEnvPath)}`);
  }
  if (options.tokenExpiresAt) {
    lines.push(`IMA_WEB_AGENT_TOKEN_EXPIRES_AT=${shellQuote(options.tokenExpiresAt)}`);
  }
  if (options.refreshTokenExpiresAt) {
    lines.push(`IMA_WEB_AGENT_REFRESH_TOKEN_EXPIRES_AT=${shellQuote(options.refreshTokenExpiresAt)}`);
  }
  if (options.refreshSkewMs) {
    lines.push(`IMA_WEB_AGENT_REFRESH_SKEW_MS=${shellQuote(options.refreshSkewMs)}`);
  }
  if (options.refreshIntervalMs) {
    lines.push(`IMA_WEB_AGENT_REFRESH_INTERVAL_MS=${shellQuote(options.refreshIntervalMs)}`);
  }
  return `${lines.join('\n')}\n`;
}

module.exports = {
  extractSources,
  buildRuntimeEnvText,
  extractExpiryMs,
  getBkn,
  IMAWebAgentClient,
  mapIMAWebAgentEvent,
  parseCookieHeader,
  parseIMAWebAgentEvent,
  parseIMAWebAgentStream,
  shouldRefreshAuth,
  isSessionExpiredError,
  stringifyCookie,
};
