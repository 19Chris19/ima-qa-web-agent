const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { commitStore, conflict } = require('./generation-store');
const { buildRuntimeEnvText } = require('./ima-web-agent-client');
const { healthMessage } = require('./account-health');

const STORE_VERSION = 1;
const DEFAULT_EVENT_LIMIT = 80;

function defaultAccountStorePath() {
  return path.resolve(__dirname, '..', '..', '..', 'runtime', 'ima-web-agent-accounts.json');
}

function defaultAccountStoreKeyPath() {
  return path.resolve(__dirname, '..', '..', '..', 'runtime', 'ima-web-agent-accounts.key');
}

class WebAgentAccountDirectory {
  constructor(options = {}) {
    this.storePath = path.resolve(options.storePath || defaultAccountStorePath());
    this.wasExisting = fs.existsSync(this.storePath);
    this.keyPath = path.resolve(options.keyPath || defaultAccountStoreKeyPath());
    this.keyMaterial = options.keyMaterial || process.env.IMA_QA_ACCOUNT_STORE_KEY || '';
    this.now = options.now || (() => new Date().toISOString());
    this.store = null;
  }

  load() {
    if (this.store) {
      return this.store;
    }

    if (!fs.existsSync(this.storePath)) {
      this.store = createEmptyStore(this.now());
      this._writeStore();
      return this.store;
    }

    const parsed = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
    this.store = {
      version: STORE_VERSION,
      generation: Number(parsed.generation || 0),
      settings: parsed.settings || {},
      createdAt: parsed.createdAt || this.now(),
      updatedAt: parsed.updatedAt || this.now(),
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts.map(normalizeStoredAccount) : [],
    };
    this._backfillIdentityFingerprints();
    this._backfillRefreshCapability();
    this._disableDuplicateIdentities();
    return this.store;
  }

  listAccounts(options = {}) {
    const includeEvents = Boolean(options.includeEvents);
    return this.load().accounts.map((account) => sanitizeAccount(account, { includeEvents }));
  }

  reload() {
    this.store = null;
    return this.load();
  }

  commitWebQualification(accountId, proof, expectedGeneration) {
    this.reload();
    if (this.store.generation !== expectedGeneration) throw conflict();
    const account = this._requireAccount(accountId);
    if (account.principalFingerprint !== proof.principalFingerprint) throw conflict();
    account.runtime.webQualification = proof;
    this._writeStore();
    return this.store.generation;
  }

  getAccount(accountId) {
    return this.load().accounts.find((account) => account.id === accountId || account.name === accountId) || null;
  }

  getPoolAccounts() {
    return this.load().accounts.map((account) => {
      const config = this._decryptRuntimeConfig(account);
      return {
        id: account.id,
        name: account.name,
        knowledgeBaseId: account.knowledgeBaseId,
        headers: config.headers,
        modelId: account.modelId,
        modelType: account.modelType,
        runtimeEnvPath: account.runtimeEnvPath,
        tokenExpiresAt: account.runtime.tokenExpiresAt,
        refreshTokenExpiresAt: account.runtime.refreshTokenExpiresAt,
        refreshSkewMs: account.runtime.refreshSkewMs,
        refreshIntervalMs: account.runtime.refreshIntervalMs,
        disabled: account.runtime.disabled,
        disabledReason: account.runtime.disabledReason,
        activeRequests: account.runtime.activeRequests,
        cooldownUntil: account.runtime.cooldownUntil,
        consecutiveErrors: account.runtime.consecutiveErrors,
        totalRequests: account.runtime.totalRequests,
        lastError: account.runtime.lastError,
        lastUsedAt: account.runtime.lastUsedAt,
        hasRefreshCredentials: account.runtime.hasRefreshCredentials,
        webQualification: account.runtime.webQualification || null,
        principalFingerprint: account.principalFingerprint,
      };
    });
  }

  upsertFromRuntimeEnv(options = {}) {
    const runtimeConfig = parseRuntimeEnvText(options.runtimeEnvText || '');
    const name = cleanAccountName(
      options.name ||
        runtimeConfig.accountName ||
        runtimeConfig.accountId ||
        path.basename(options.runtimeEnvPath || runtimeConfig.runtimeEnvPath || 'account'),
    );
    const id = normalizeAccountId(runtimeConfig.accountId || options.id || name);
    const runtimeEnvPath = options.runtimeEnvPath || runtimeConfig.runtimeEnvPath || '';
    const account = {
      id,
      name,
      knowledgeBaseId: options.knowledgeBaseId || runtimeConfig.knowledgeBaseId,
      modelId: runtimeConfig.modelId,
      modelType: runtimeConfig.modelType,
      runtimeEnvPath,
      source: options.source || 'runtime-env',
      principalFingerprint: this._identityFingerprint(runtimeConfig.headers),
      runtime: {
        ...defaultRuntimeState(),
        hasRefreshCredentials: hasRefreshCredentials(runtimeConfig.headers),
        tokenExpiresAt: runtimeConfig.tokenExpiresAt,
        refreshTokenExpiresAt: runtimeConfig.refreshTokenExpiresAt,
        refreshSkewMs: runtimeConfig.refreshSkewMs,
        refreshIntervalMs: runtimeConfig.refreshIntervalMs,
      },
    };

    const runtimeEnvText = buildRuntimeEnvText({
      accountId: id,
      accountName: name,
      knowledgeBaseId: account.knowledgeBaseId,
      headers: runtimeConfig.headers,
      modelId: account.modelId,
      modelType: account.modelType,
      runtimeEnvPath,
      tokenExpiresAt: account.runtime.tokenExpiresAt,
      refreshTokenExpiresAt: account.runtime.refreshTokenExpiresAt,
      refreshSkewMs: account.runtime.refreshSkewMs,
      refreshIntervalMs: account.runtime.refreshIntervalMs,
    });

    this._upsertAccount(
      account,
      runtimeEnvText,
      {
        eventType: 'account_imported',
        message: `Imported ${name} from runtime env`,
      },
      { replace: Boolean(options.replace) },
    );
    if (runtimeEnvPath) {
      this.writeRuntimeEnvFile(id);
    }
    return sanitizeAccount(this.getAccount(id), { includeEvents: true });
  }

  upsertCapturedAccount(options = {}) {
    const name = cleanAccountName(options.name || options.id || 'account');
    const id = normalizeAccountId(options.id || name);
    const runtimeEnvPath = options.runtimeEnvPath || '';
    const headers = normalizeHeaders(options.headers);
    const account = {
      id,
      name,
      knowledgeBaseId: cleanRequired(options.knowledgeBaseId, 'knowledgeBaseId'),
      modelId: String(options.modelId || 'official_3'),
      modelType: Number(options.modelType || 3),
      runtimeEnvPath,
      source: options.source || 'browser-capture',
      principalFingerprint: this._identityFingerprint(headers),
      runtime: {
        ...defaultRuntimeState(),
        hasRefreshCredentials: hasRefreshCredentials(headers),
        tokenExpiresAt: nullableNumber(options.tokenExpiresAt),
        refreshTokenExpiresAt: nullableNumber(options.refreshTokenExpiresAt),
        refreshSkewMs: nullableNumber(options.refreshSkewMs) || 10 * 60 * 1000,
        refreshIntervalMs: nullableNumber(options.refreshIntervalMs) || 60 * 1000,
      },
    };

    const runtimeEnvText = buildRuntimeEnvText({
      accountId: id,
      accountName: name,
      knowledgeBaseId: account.knowledgeBaseId,
      headers,
      modelId: account.modelId,
      modelType: account.modelType,
      runtimeEnvPath,
      tokenExpiresAt: account.runtime.tokenExpiresAt,
      refreshTokenExpiresAt: account.runtime.refreshTokenExpiresAt,
      refreshSkewMs: account.runtime.refreshSkewMs,
      refreshIntervalMs: account.runtime.refreshIntervalMs,
    });

    this._upsertAccount(
      account,
      runtimeEnvText,
      {
        eventType: 'account_captured',
        message: `Captured ${name} from browser login`,
      },
      { replace: Boolean(options.replace) },
    );
    if (runtimeEnvPath) {
      this.writeRuntimeEnvFile(id);
    }
    return sanitizeAccount(this.getAccount(id), { includeEvents: true });
  }

  replaceCapturedAccount(accountId, options = {}) {
    const existing = this._requireAccount(accountId);
    const headers = normalizeHeaders(options.headers);
    const nextFingerprint = this._identityFingerprint(headers);
    if (!existing.principalFingerprint || !nextFingerprint) {
      const error = new Error('无法证明扫码登录与原 IMA 身份一致，已保留原登录态');
      error.statusCode = 409;
      error.code = 'ima_identity_unverified';
      throw error;
    }
    if (existing.principalFingerprint !== nextFingerprint) {
      const error = new Error('扫码登录的 IMA 身份不是原账号，已保留原登录态');
      error.statusCode = 409;
      error.code = 'ima_identity_mismatch';
      throw error;
    }
    return this.upsertCapturedAccount({
      id: existing.id,
      name: existing.name,
      routingLane: existing.routingLane,
      knowledgeBaseId: options.knowledgeBaseId || existing.knowledgeBaseId,
      headers,
      modelId: options.modelId || existing.modelId,
      modelType: options.modelType || existing.modelType,
      runtimeEnvPath: existing.runtimeEnvPath,
      tokenExpiresAt: options.tokenExpiresAt,
      refreshTokenExpiresAt: options.refreshTokenExpiresAt,
      refreshSkewMs: options.refreshSkewMs,
      refreshIntervalMs: options.refreshIntervalMs,
      source: options.source || 'admin-qr-reauth',
      replace: true,
    });
  }

  setDisabled(accountId, disabled, reason = '') {
    const account = this._requireAccount(accountId);
    if (!disabled && account.runtime.disabledReason === 'duplicate_ima_identity') {
      const error = new Error('该条目与账号池中另一条记录属于同一个 IMA 账号，不能启用为额外并发。请保留其中一条并删除另一条。');
      error.statusCode = 409;
      error.code = 'duplicate_ima_identity';
      throw error;
    }
    account.runtime.disabled = Boolean(disabled);
    account.runtime.disabledReason = disabled ? cleanText(reason || 'disabled_by_admin') : '';
    account.runtime.updatedAt = this.now();
    addEvent(account, {
      type: disabled ? 'account_disabled' : 'account_enabled',
      message: disabled ? 'Account disabled by admin' : 'Account enabled by admin',
    }, this.now);
    this._writeStore();
    return sanitizeAccount(account, { includeEvents: true });
  }

  deleteAccount(accountId) {
    const store = this.load();
    const index = store.accounts.findIndex((account) => account.id === accountId || account.name === accountId);
    if (index < 0) {
      return false;
    }
    const [account] = store.accounts.splice(index, 1);
    this._writeStore();
    this._removeManagedRuntimeEnvFile(account.runtimeEnvPath);
    return true;
  }

  recordRuntimeState(snapshot = {}) {
    const account = this.getAccount(snapshot.id || snapshot.name || '');
    if (!account) {
      return false;
    }
    account.runtime.activeRequests = Number(snapshot.activeRequests || 0);
    account.runtime.cooldownUntil = Number(snapshot.cooldownUntil || 0);
    account.runtime.consecutiveErrors = Number(snapshot.consecutiveErrors || 0);
    account.runtime.totalRequests = Number(snapshot.totalRequests || 0);
    account.runtime.lastUsedAt = Number(snapshot.lastUsedAt || 0);
    account.runtime.lastError = cleanText(snapshot.lastError || '');
    account.runtime.disabled = Boolean(snapshot.disabled);
    account.runtime.disabledReason = cleanText(snapshot.disabledReason || '');
    account.runtime.updatedAt = this.now();
    this._writeStore();
    return true;
  }

  recordEvent(accountId, type, message, meta = {}) {
    const account = this._requireAccount(accountId);
    addEvent(account, { type, message, meta }, this.now);
    this._writeStore();
    return sanitizeAccount(account, { includeEvents: true });
  }

  recordAccountHealth(accountId, outcome = {}) {
    const account = this._requireAccount(accountId);
    const operation = outcome.operation === 'refresh' ? 'refresh' : 'check';
    const code = cleanText(outcome.code) || 'upstream_temporary';
    const now = this.now();
    const checkedAt = cleanText(outcome.checkedAt) || now;
    account.runtime.lastCheckAt = checkedAt;
    account.runtime.lastCheckCode = code;
    account.runtime.lastCheckMessage = healthMessage(code);
    if (typeof outcome.sessionValid === 'boolean') {
      account.runtime.sessionValid = outcome.sessionValid;
    }
    if (typeof outcome.knowledgeReady === 'boolean') {
      account.runtime.knowledgeReady = outcome.knowledgeReady;
    }
    if (typeof outcome.webReady === 'boolean') {
      account.runtime.webReady = outcome.webReady;
    }
    if (operation === 'refresh') {
      account.runtime.lastRefreshAt = now;
      account.runtime.lastRefreshCode = code;
      account.runtime.lastRefreshError = code === 'ok' ? '' : healthMessage(code);
    }
    account.runtime.updatedAt = now;
    addEvent(account, {
      type: code === 'ok' ? `account_${operation}ed` : `account_${operation}_failed`,
      message: code === 'ok' ? `Account ${operation} completed` : `Account ${operation} failed`,
      meta: { code },
    }, this.now);
    this._writeStore();
    return sanitizeAccount(account, { includeEvents: true });
  }

  updateCredentialsFromClient(accountId, clientSnapshot = {}) {
    const account = this._requireAccount(accountId);
    const nextIdentityFingerprint = this._identityFingerprint(clientSnapshot.headers);
    if (
      account.principalFingerprint &&
      nextIdentityFingerprint &&
      account.principalFingerprint !== nextIdentityFingerprint
    ) {
      const error = new Error('刷新后的登录态属于另一个 IMA 账号，已拒绝覆盖当前账号');
      error.statusCode = 409;
      error.code = 'ima_identity_mismatch';
      throw error;
    }
    const runtimeEnvText = buildRuntimeEnvText({
      accountId: account.id,
      accountName: account.name,
      knowledgeBaseId: clientSnapshot.knowledgeBaseId || account.knowledgeBaseId,
      headers: clientSnapshot.headers,
      modelId: clientSnapshot.modelId || account.modelId,
      modelType: clientSnapshot.modelType || account.modelType,
      runtimeEnvPath: clientSnapshot.runtimeEnvPath || account.runtimeEnvPath,
      tokenExpiresAt: clientSnapshot.tokenExpiresAt,
      refreshTokenExpiresAt: clientSnapshot.refreshTokenExpiresAt,
      refreshSkewMs: clientSnapshot.refreshSkewMs,
      refreshIntervalMs: clientSnapshot.refreshIntervalMs,
    });
    account.knowledgeBaseId = clientSnapshot.knowledgeBaseId || account.knowledgeBaseId;
    account.modelId = clientSnapshot.modelId || account.modelId;
    account.modelType = Number(clientSnapshot.modelType || account.modelType);
    account.runtimeEnvPath = clientSnapshot.runtimeEnvPath || account.runtimeEnvPath;
    account.runtime.tokenExpiresAt = nullableNumber(clientSnapshot.tokenExpiresAt);
    account.runtime.refreshTokenExpiresAt = nullableNumber(clientSnapshot.refreshTokenExpiresAt);
    account.runtime.refreshSkewMs = nullableNumber(clientSnapshot.refreshSkewMs) || account.runtime.refreshSkewMs;
    account.runtime.refreshIntervalMs =
      nullableNumber(clientSnapshot.refreshIntervalMs) || account.runtime.refreshIntervalMs;
    account.runtime.hasRefreshCredentials = hasRefreshCredentials(clientSnapshot.headers);
    account.principalFingerprint = nextIdentityFingerprint || account.principalFingerprint || '';
    account.runtime.lastRefreshAt = this.now();
    account.runtime.lastRefreshError = '';
    account.secret = this._encryptText(runtimeEnvText);
    addEvent(account, { type: 'auth_refreshed', message: 'Account auth refreshed' }, this.now);
    this._writeStore();
    if (account.runtimeEnvPath) {
      this.writeRuntimeEnvFile(account.id);
    }
    return sanitizeAccount(account, { includeEvents: true });
  }

  writeRuntimeEnvFile(accountId) {
    const account = this._requireAccount(accountId);
    if (!account.runtimeEnvPath) {
      throw new Error('runtimeEnvPath is not configured for this account');
    }
    const runtimeEnvText = this._decryptText(account.secret);
    const dir = path.dirname(account.runtimeEnvPath);
    const tempPath = path.join(dir, `.${path.basename(account.runtimeEnvPath)}.${process.pid}.tmp`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tempPath, runtimeEnvText, { mode: 0o600 });
    fs.renameSync(tempPath, account.runtimeEnvPath);
    try {
      fs.chmodSync(account.runtimeEnvPath, 0o600);
    } catch {
      // Best effort only; write mode covers normal creation.
    }
    return account.runtimeEnvPath;
  }

  disableRuntimeEnvExport(accountId) {
    const account = this._requireAccount(accountId);
    const previousRuntimeEnvPath = account.runtimeEnvPath;
    if (!previousRuntimeEnvPath) {
      return {
        account: sanitizeAccount(account, { includeEvents: true }),
        removedManagedRuntimeEnv: false,
      };
    }

    const runtimeConfig = this._decryptRuntimeConfig(account);
    const runtimeEnvText = buildRuntimeEnvText({
      accountId: account.id,
      accountName: account.name,
      knowledgeBaseId: account.knowledgeBaseId,
      headers: runtimeConfig.headers,
      modelId: account.modelId,
      modelType: account.modelType,
      runtimeEnvPath: '',
      tokenExpiresAt: account.runtime.tokenExpiresAt,
      refreshTokenExpiresAt: account.runtime.refreshTokenExpiresAt,
      refreshSkewMs: account.runtime.refreshSkewMs,
      refreshIntervalMs: account.runtime.refreshIntervalMs,
    });
    account.runtimeEnvPath = '';
    account.secret = this._encryptText(runtimeEnvText);
    account.runtime.updatedAt = this.now();
    addEvent(account, {
      type: 'runtime_export_disabled',
      message: 'Legacy plaintext runtime export disabled',
    }, this.now);
    this._writeStore();
    const removedManagedRuntimeEnv = this._removeManagedRuntimeEnvFile(previousRuntimeEnvPath);
    return {
      account: sanitizeAccount(account, { includeEvents: true }),
      removedManagedRuntimeEnv,
    };
  }

  getHealthSnapshot(options = {}) {
    const accounts = this.listAccounts({ includeEvents: options.includeDetails });
    return {
      available: true,
      storePath: options.includeDetails ? this.storePath : undefined,
      accountCount: accounts.length,
      activeAccounts: accounts.filter((account) => account.status !== 'disabled').length,
      disabledAccounts: accounts.filter((account) => account.status === 'disabled').length,
      accounts: options.includeDetails ? accounts : undefined,
    };
  }

  _upsertAccount(nextAccount, runtimeEnvText, event, options = {}) {
    const store = this.load();
    const now = this.now();
    const existing = store.accounts.find(
      (account) => account.id === nextAccount.id || account.name === nextAccount.name,
    );
    if (existing && !options.replace) {
      const error = new Error(`账号 ${existing.name} 已存在；如确认要重新绑定登录态，请显式使用 replace`);
      error.statusCode = 409;
      throw error;
    }
    const duplicateIdentity = nextAccount.principalFingerprint
      ? store.accounts.find((account) =>
        account.principalFingerprint === nextAccount.principalFingerprint && account.id !== nextAccount.id,
      )
      : null;
    if (duplicateIdentity) {
      const error = new Error(`扫码的 IMA 账号已作为“${duplicateIdentity.name}”在账号池中。未新增重复账号；如需重新绑定，请使用原账号名称。`);
      error.statusCode = 409;
      error.code = 'duplicate_ima_identity';
      throw error;
    }
    const account = existing || {
      id: nextAccount.id,
      name: nextAccount.name,
      createdAt: now,
      events: [],
    };
    account.id = nextAccount.id;
    account.name = nextAccount.name;
    account.knowledgeBaseId = nextAccount.knowledgeBaseId;
    account.modelId = nextAccount.modelId;
    account.modelType = nextAccount.modelType;
    account.runtimeEnvPath = nextAccount.runtimeEnvPath;
    account.source = nextAccount.source;
    account.principalFingerprint = nextAccount.principalFingerprint || account.principalFingerprint || '';
    account.runtime = {
      ...defaultRuntimeState(),
      ...(existing?.runtime || {}),
      ...nextAccount.runtime,
      updatedAt: now,
    };
    account.secret = this._encryptText(runtimeEnvText);
    account.updatedAt = now;
    addEvent(account, event, this.now);
    if (!existing) {
      store.accounts.push(account);
    }
    this._writeStore();
  }

  _backfillIdentityFingerprints() {
    let changed = false;
    for (const account of this.store.accounts) {
      if (account.principalFingerprint) {
        continue;
      }
      try {
        const fingerprint = this._identityFingerprint(this._decryptRuntimeConfig(account).headers);
        if (fingerprint) {
          account.principalFingerprint = fingerprint;
          changed = true;
        }
      } catch {
        // An unreadable legacy record is left untouched and remains subject to normal auth checks.
      }
    }
    if (changed) {
      this._writeStore();
    }
  }

  _disableDuplicateIdentities() {
    const seen = new Map();
    let changed = false;
    for (const account of this.store.accounts) {
      if (!account.principalFingerprint) {
        continue;
      }
      const canonical = seen.get(account.principalFingerprint);
      if (!canonical) {
        seen.set(account.principalFingerprint, account);
        continue;
      }
      if (!account.runtime.disabled || account.runtime.disabledReason !== 'duplicate_ima_identity') {
        account.runtime.disabled = true;
        account.runtime.disabledReason = 'duplicate_ima_identity';
        account.runtime.updatedAt = this.now();
        addEvent(account, {
          type: 'duplicate_ima_identity_disabled',
          message: `Disabled because it duplicates IMA identity already assigned to ${canonical.name}`,
        }, this.now);
        changed = true;
      }
    }
    if (changed) {
      this._writeStore();
    }
  }

  _backfillRefreshCapability() {
    let changed = false;
    for (const account of this.store.accounts) {
      if (account.runtime.hasRefreshCredentials) {
        continue;
      }
      try {
        if (hasRefreshCredentials(this._decryptRuntimeConfig(account).headers)) {
          account.runtime.hasRefreshCredentials = true;
          changed = true;
        }
      } catch {
        // A legacy unreadable record remains non-refreshable until it is re-enrolled.
      }
    }
    if (changed) {
      this._writeStore();
    }
  }

  _identityFingerprint(headers) {
    const principalId = getImaPrincipalId(headers);
    if (!principalId) {
      return '';
    }
    return crypto.createHmac('sha256', this._key())
      .update(`ima-principal:${principalId}`)
      .digest('base64url');
  }

  _requireAccount(accountId) {
    const account = this.getAccount(accountId);
    if (!account) {
      const error = new Error('Account not found');
      error.statusCode = 404;
      throw error;
    }
    return account;
  }

  _decryptRuntimeConfig(account) {
    return parseRuntimeEnvText(this._decryptText(account.secret));
  }

  _encryptText(text) {
    const key = this._key();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
    return {
      alg: 'aes-256-gcm',
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  }

  _decryptText(secret) {
    if (!secret?.ciphertext || !secret?.iv || !secret?.tag) {
      throw new Error('Account secret is missing or malformed');
    }
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      this._key(),
      Buffer.from(secret.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(secret.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(secret.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }

  _key() {
    const material = this.keyMaterial || ensureKeyFile(this.keyPath);
    return crypto.createHash('sha256').update(String(material)).digest();
  }

  _writeStore() {
    const store = this.load();
    store.updatedAt = this.now();
    try {
      const next = commitStore(this.storePath, store);
      store.generation = next.generation;
    } catch (error) {
      this.store = null;
      throw error;
    }
  }

  _removeManagedRuntimeEnvFile(runtimeEnvPath) {
    const candidate = String(runtimeEnvPath || '').trim();
    if (!candidate) {
      return false;
    }
    const managedDirectory = path.resolve(path.dirname(this.storePath), 'web-agent-accounts');
    const resolvedPath = path.resolve(candidate);
    if (!resolvedPath.startsWith(`${managedDirectory}${path.sep}`)) {
      return false;
    }
    fs.rmSync(resolvedPath, { force: true });
    return true;
  }
}

function createEmptyStore(now) {
  const timestamp = now;
  return {
    version: STORE_VERSION,
    createdAt: timestamp,
    updatedAt: timestamp,
    accounts: [],
  };
}

function normalizeStoredAccount(account) {
  return {
    id: normalizeAccountId(account.id || account.name),
    name: cleanAccountName(account.name || account.id || 'account'),
    knowledgeBaseId: cleanText(account.knowledgeBaseId),
    modelId: cleanText(account.modelId) || 'official_3',
    modelType: Number(account.modelType || 3),
    runtimeEnvPath: cleanText(account.runtimeEnvPath),
    source: cleanText(account.source) || 'unknown',
    principalFingerprint: cleanText(account.principalFingerprint),
    createdAt: cleanText(account.createdAt),
    updatedAt: cleanText(account.updatedAt),
    runtime: { ...defaultRuntimeState(), ...(account.runtime || {}) },
    events: Array.isArray(account.events) ? account.events.slice(-DEFAULT_EVENT_LIMIT) : [],
    secret: account.secret || null,
  };
}

function parseRuntimeEnvText(text) {
  const parsed = dotenv.parse(String(text || ''));
  const headers = parseHeaders(parsed.IMA_WEB_AGENT_HEADERS_JSON);
  return {
    accountId: cleanText(parsed.IMA_WEB_AGENT_ACCOUNT_ID),
    accountName: cleanText(parsed.IMA_WEB_AGENT_ACCOUNT_NAME),
    knowledgeBaseId: cleanRequired(parsed.IMA_WEB_KNOWLEDGE_BASE_ID, 'IMA_WEB_KNOWLEDGE_BASE_ID'),
    headers,
    modelId: cleanText(parsed.IMA_WEB_AGENT_MODEL_ID) || 'official_3',
    modelType: Number(parsed.IMA_WEB_AGENT_MODEL_TYPE || 3),
    runtimeEnvPath: cleanText(parsed.IMA_WEB_AGENT_RUNTIME_ENV_PATH),
    tokenExpiresAt: nullableNumber(parsed.IMA_WEB_AGENT_TOKEN_EXPIRES_AT),
    refreshTokenExpiresAt: nullableNumber(parsed.IMA_WEB_AGENT_REFRESH_TOKEN_EXPIRES_AT),
    refreshSkewMs: nullableNumber(parsed.IMA_WEB_AGENT_REFRESH_SKEW_MS) || 10 * 60 * 1000,
    refreshIntervalMs: nullableNumber(parsed.IMA_WEB_AGENT_REFRESH_INTERVAL_MS) || 60 * 1000,
  };
}

function parseHeaders(value) {
  let parsed;
  try {
    parsed = JSON.parse(String(value || '{}'));
  } catch {
    throw new Error('IMA_WEB_AGENT_HEADERS_JSON must be valid JSON');
  }
  return normalizeHeaders(parsed);
}

function normalizeHeaders(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    throw new Error('headers must be an object');
  }
  const cookie = cleanRequired(headers['x-ima-cookie'] || headers.cookie, 'x-ima-cookie');
  return {
    'x-ima-cookie': cookie,
    'x-ima-bkn': cleanText(headers['x-ima-bkn']),
  };
}

function getImaPrincipalId(headers) {
  const cookie = String(headers?.['x-ima-cookie'] || headers?.cookie || '');
  const match = cookie.match(/(?:^|;\s*)IMA-UID=([^;\s]+)/i);
  return match ? String(match[1] || '').trim() : '';
}

function sanitizeAccount(account, options = {}) {
  const status = account.runtime?.disabled
    ? 'disabled'
    : Number(account.runtime?.activeRequests || 0) > 0
      ? 'busy'
      : Number(account.runtime?.cooldownUntil || 0) > Date.now()
        ? 'cooling_down'
        : 'available';
  return {
    id: account.id,
    name: account.name,
    knowledgeBaseId: account.knowledgeBaseId,
    modelId: account.modelId,
    modelType: account.modelType,
    runtimeEnvPath: account.runtimeEnvPath,
    source: account.source,
    identityVerified: Boolean(account.principalFingerprint),
    identityDuplicate: account.runtime?.disabledReason === 'duplicate_ima_identity',
    status,
    disabledReason: account.runtime?.disabledReason || '',
    activeRequests: Number(account.runtime?.activeRequests || 0),
    cooldownSecondsRemaining: Math.max(0, Math.ceil((Number(account.runtime?.cooldownUntil || 0) - Date.now()) / 1000)),
    consecutiveErrors: Number(account.runtime?.consecutiveErrors || 0),
    totalRequests: Number(account.runtime?.totalRequests || 0),
    lastUsedAt: account.runtime?.lastUsedAt ? new Date(account.runtime.lastUsedAt).toISOString() : null,
    lastError: account.runtime?.lastError || null,
    tokenExpiresAt: account.runtime?.tokenExpiresAt
      ? new Date(Number(account.runtime.tokenExpiresAt)).toISOString()
      : null,
    refreshTokenExpiresAt: account.runtime?.refreshTokenExpiresAt
      ? new Date(Number(account.runtime.refreshTokenExpiresAt)).toISOString()
      : null,
    health: buildSanitizedHealth(account),
    hasCredentials: Boolean(account.secret),
    createdAt: account.createdAt || null,
    updatedAt: account.updatedAt || null,
    events: options.includeEvents ? account.events || [] : undefined,
  };
}

function defaultRuntimeState() {
  return {
    disabled: false,
    disabledReason: '',
    activeRequests: 0,
    cooldownUntil: 0,
    consecutiveErrors: 0,
    totalRequests: 0,
    lastUsedAt: 0,
    lastError: '',
    tokenExpiresAt: null,
    refreshTokenExpiresAt: null,
    refreshSkewMs: 10 * 60 * 1000,
    refreshIntervalMs: 60 * 1000,
    lastRefreshAt: null,
    lastRefreshError: '',
    lastRefreshCode: '',
    lastCheckAt: null,
    lastCheckCode: 'account_not_checked',
    lastCheckMessage: healthMessage('account_not_checked'),
    sessionValid: null,
    knowledgeReady: null,
    webReady: null,
    hasRefreshCredentials: false,
    webQualification: null,
    updatedAt: null,
  };
}

function buildSanitizedHealth(account) {
  const runtime = account.runtime || {};
  const now = Date.now();
  const localSchedulable = !runtime.disabled &&
    Number(runtime.activeRequests || 0) === 0 &&
    Number(runtime.cooldownUntil || 0) <= now;
  const refreshable = Boolean(runtime.hasRefreshCredentials) &&
    (!runtime.refreshTokenExpiresAt || Number(runtime.refreshTokenExpiresAt) > now);
  const sessionValid = typeof runtime.sessionValid === 'boolean' ? runtime.sessionValid : null;
  const knowledgeReady = typeof runtime.knowledgeReady === 'boolean' ? runtime.knowledgeReady : null;
  const webReady = typeof runtime.webReady === 'boolean' ? runtime.webReady : null;
  const ready = localSchedulable && runtime.lastCheckCode === 'ok' && sessionValid === true && knowledgeReady === true && webReady === true;
  const unavailable = runtime.disabled || sessionValid === false || knowledgeReady === false || webReady === false;
  return {
    local_schedulable: localSchedulable,
    session_valid: sessionValid,
    refreshable,
    knowledge_ready: knowledgeReady,
    web_ready: webReady,
    status: ready ? 'ready' : unavailable ? 'unavailable' : 'needs_check',
    last_check_at: runtime.lastCheckAt || null,
    last_check_code: runtime.lastCheckCode || 'account_not_checked',
    last_check_message: runtime.lastCheckMessage || healthMessage('account_not_checked'),
    last_refresh_at: runtime.lastRefreshAt || null,
    last_refresh_code: runtime.lastRefreshCode || null,
  };
}

function hasRefreshCredentials(headers) {
  const cookie = String(headers?.['x-ima-cookie'] || headers?.cookie || '');
  return /(?:^|;\s*)IMA-UID=[^;\s]+/i.test(cookie) &&
    /(?:^|;\s*)IMA-REFRESH-TOKEN=[^;\s]+/i.test(cookie);
}

function addEvent(account, event = {}, now) {
  account.events ||= [];
  account.events.push({
    at: now(),
    type: cleanText(event.type || event.eventType || 'event'),
    message: cleanText(event.message || ''),
    meta: sanitizeMeta(event.meta || {}),
  });
  account.events = account.events.slice(-DEFAULT_EVENT_LIMIT);
}

function sanitizeMeta(value) {
  const json = JSON.stringify(value || {});
  if (/cookie|token|apikey|api_key|headers/i.test(json)) {
    return { redacted: true };
  }
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

function ensureKeyFile(keyPath) {
  if (fs.existsSync(keyPath)) {
    return fs.readFileSync(keyPath, 'utf8').trim();
  }
  const dir = path.dirname(keyPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = crypto.randomBytes(32).toString('base64');
  fs.writeFileSync(keyPath, `${key}\n`, { mode: 0o600 });
  return key;
}

function cleanRequired(value, name) {
  const text = cleanText(value);
  if (!text) {
    throw new Error(`${name} is required`);
  }
  return text;
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function cleanAccountName(value) {
  return cleanText(value).slice(0, 80) || 'account';
}

function normalizeAccountId(value) {
  const text = cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return text || `account-${crypto.randomUUID().slice(0, 8)}`;
}

function nullableNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : null;
}

module.exports = {
  WebAgentAccountDirectory,
  defaultAccountStoreKeyPath,
  defaultAccountStorePath,
  getImaPrincipalId,
  parseRuntimeEnvText,
  normalizeAccountId,
};
