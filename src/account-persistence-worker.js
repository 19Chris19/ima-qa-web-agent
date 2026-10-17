'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebAgentAccountDirectory } = require('./web-agent-account-directory');
const { AirAccountDirectory } = require('./air/account-directory');
const { commitStoreAsync, conflict, atomicPrivateWriteAsync, reconfirmStoreAsync } = require('./generation-store');

const Directory = workerData.air ? AirAccountDirectory : WebAgentAccountDirectory;
const options = workerData.options;
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safeError = error => ({ code: /^[a-z_]+$/.test(error.code || '') ? error.code : 'account_store_operation_failed',
  statusCode: Number.isInteger(error.statusCode) ? error.statusCode : 503 });
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const mutations = new Set(['beginWebQualification', 'commitWebQualification', 'setMaxConcurrent',
  'upsertFromRuntimeEnv', 'upsertCapturedAccount', 'addCapturedAccount', 'replaceCapturedAccount', 'setDisabled',
  'deleteAccount', 'recordEvent', 'recordAccountHealth', 'updateCredentialsFromClient', 'writeRuntimeEnvFile',
  'disableRuntimeEnvExport', 'setRoutingLane', 'applyKnowledgeAgentQualification', 'recordKnowledgeAgentQualifications']);
let directory, stats = new Map(), revision = 0;
let prepared;
const statsFile = `${options.storePath}.runtime-stats.json`;
const metrics = { commits: 0, statsCommits: 0, bytes: 0, commitMs: 0 };

function validateStore(allowMissing = false) {
  let exists = false;
  try {
    const stat = fs.lstatSync(options.storePath);
    exists = true;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024
        || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid()) throw Error();
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(options.storePath)));
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.accounts)
        || (value.generation !== undefined && (!Number.isSafeInteger(value.generation) || value.generation < 0))
        || value.accounts.some(row => !row || typeof row !== 'object' || Array.isArray(row)
          || typeof (row.id || row.name) !== 'string' || !(row.id || row.name))) throw Error();
    const ids = value.accounts.map(row => row.id || row.name);
    if (new Set(ids).size !== ids.length) throw Error();
    if (value.accounts.length && !options.keyMaterial) {
      const key = fs.lstatSync(options.keyPath);
      if (!key.isFile() || key.isSymbolicLink() || key.nlink !== 1 || key.uid !== process.getuid()
          || (key.mode & 0o777) !== 0o600) throw Error();
    }
    return value;
  } catch (error) {
    if (error.code === 'ENOENT' && allowMissing && !exists) return;
    throw Object.assign(new Error('account_store_invalid'), { code: 'account_store_invalid', statusCode: 503 });
  }
}

function mergeStats() {
  const next = new Map();
  for (const account of directory.load().accounts) {
    const old = stats.get(account.id);
    next.set(account.id, old?.principalFingerprint === account.principalFingerprint ? old : {
      id: account.id, principalFingerprint: account.principalFingerprint || '',
      totalRequests: account.runtime.totalRequests || 0, lastUsedAt: account.runtime.lastUsedAt || 0,
    });
  }
  stats = next;
}
function loadStats() {
  mergeStats();
  if (!fs.existsSync(statsFile)) return;
  const stat = fs.lstatSync(statsFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600
      || stat.uid !== process.getuid() || stat.size > 1024 * 1024) throw Error('stats_store_invalid');
  const value = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
  if (!exactKeys(value, ['schemaVersion', 'accounts']) || value.schemaVersion !== 1
      || !Array.isArray(value.accounts) || value.accounts.length > 2000) throw Error('stats_store_invalid');
  const seen = new Set();
  for (const row of value.accounts) {
    if (!exactKeys(row, ['id', 'principalFingerprint', 'totalRequests', 'lastUsedAt'])
        || typeof row.id !== 'string' || seen.has(row.id) || typeof row.principalFingerprint !== 'string'
        || !Number.isSafeInteger(row.totalRequests) || row.totalRequests < 0
        || !Number.isFinite(row.lastUsedAt) || row.lastUsedAt < 0) throw Error('stats_store_invalid');
    seen.add(row.id);
    if (stats.get(row.id)?.principalFingerprint === row.principalFingerprint) stats.set(row.id, row);
  }
}
function snapshot() {
  mergeStats();
  return { store: directory.load(), pool: directory.getPoolAccounts().map(row => ({ ...row, activeRequests: 0 })),
    stats: [...stats.values()], metrics: { ...metrics }, digest: digest(directory.load()),
    diskDigest: digest(JSON.parse(fs.readFileSync(options.storePath, 'utf8'))) };
}

async function applyEffects(target, effects) {
  for (const effect of effects) {
    if (effect.kind === 'export') {
      const account = target._requireAccount(effect.accountId);
      await atomicPrivateWriteAsync(account.runtimeEnvPath, target._decryptText(account.secret));
    } else if (effect.kind === 'remove') {
      const managed = path.resolve(path.dirname(options.storePath), 'web-agent-accounts') + path.sep;
      if (!effect.file.startsWith(managed)) throw Error('unsafe_runtime_export');
      await fs.promises.rm(effect.file, { force: true });
    } else throw Error('invalid_store_effect');
  }
}

// Each operation gets its own draft; all disk side effects follow one CAS commit.
async function transact(id, method, args, expectedGeneration, expectedDigest) {
  const before = validateStore();
  if (digest(before) !== expectedDigest) throw conflict();
  const next = new Directory(options);
  let dirty = false;
  const effects = [];
  next._writeStore = () => { next.store.updatedAt = next.now(); dirty = true; };
  next.load();
  if (Number(next.store.generation || 0) !== expectedGeneration) throw conflict();
  // Nested mutation methods may reload. The transaction has already read disk.
  next.reload = () => next.load();
  next.writeRuntimeEnvFile = accountId => {
    const account = next._requireAccount(accountId);
    if (!account.runtimeEnvPath) throw Error('runtime_env_not_configured');
    effects.push({ kind: 'export', accountId });
    return account.runtimeEnvPath;
  };
  next._removeManagedRuntimeEnvFile = candidate => {
    const managed = path.resolve(path.dirname(options.storePath), 'web-agent-accounts') + path.sep;
    const file = candidate ? path.resolve(candidate) : '';
    if (!file.startsWith(managed)) return false;
    effects.push({ kind: 'remove', file }); return true;
  };
  let result;
  if (method === 'initializeWebMode' || method === 'setWebMode') {
    const mode = args[0];
    if (mode && !['classic_knowledge', 'knowledge_agent'].includes(mode)) throw Error('invalid_web_mode');
    if (method === 'setWebMode' || !next.store.settings.webMode) {
      next.store.settings.webMode = mode || (workerData.wasExisting ? 'classic_knowledge' : 'knowledge_agent');
      next._writeStore();
    }
  } else if (method === 'recordRuntimeStateCritical') {
    const observation = args[0], account = next.getAccount(observation.id);
    result = false;
    if (account) {
      for (const key of ['cooldownUntil', 'consecutiveErrors', 'lastError', 'disabled', 'disabledReason']) {
        if (!(key in observation) || (['disabled', 'disabledReason'].includes(key)
            && account.runtime.enrollmentQualificationRequired === true)) continue;
        if (['disabled', 'disabledReason'].includes(key) && account.runtime.disabled === true) continue;
        if (account.runtime[key] !== observation[key]) { account.runtime[key] = observation[key]; dirty = true; }
      }
      if (dirty) { account.runtime.updatedAt = next.now(); next._writeStore(); }
      result = true;
    }
  } else if (method === 'mirrorStats') {
    mergeStats();
    for (const account of next.store.accounts) {
      const row = stats.get(account.id);
      if (row?.principalFingerprint !== account.principalFingerprint) continue;
      for (const key of ['totalRequests', 'lastUsedAt']) if (account.runtime[key] !== row[key]) {
        account.runtime[key] = row[key]; dirty = true;
      }
      if (account.runtime.activeRequests !== 0) { account.runtime.activeRequests = 0; dirty = true; }
    }
    if (dirty) next._writeStore();
  } else {
    if (!mutations.has(method) || typeof next[method] !== 'function') throw Error('invalid_store_operation');
    if (method === 'applyKnowledgeAgentQualification') {
      const expected = args[2], account = next.getAccount(args[0]);
      if (!account || !expected || expected.digest !== digest(account)) throw conflict();
      args[2] = { ...expected, account, events: account.events };
    }
    result = next[method](...args);
  }
  if (dirty) {
    const proposed = { ...next.store, generation: expectedGeneration + 1 };
    const receipt = { before: digest(before),
      after: digest(proposed), generation: proposed.generation, effects };
    parentPort.postMessage({ id, prepared: receipt });
    prepared = { id, receipt };
    const start = performance.now();
    next.store = await commitStoreAsync(options.storePath, next.store);
    metrics.commits++; metrics.bytes += Buffer.byteLength(JSON.stringify(next.store));
    metrics.commitMs += performance.now() - start;
  }
  await applyEffects(next, effects);
  directory = new Directory(options); directory.store = next.store;
  revision++;
  return method === 'commitWebQualification' ? next.store.generation : result;
}

async function command(message) {
  const { id, method, args = [], expectedGeneration, expectedDigest } = message;
  try {
    let result;
    if (method === 'init') {
      fs.mkdirSync(path.dirname(options.storePath), { recursive: true, mode: 0o700 });
      validateStore(!args[0]?.readOnly && !workerData.wasExisting);
      directory = new Directory(options);
      if (args[0]?.readOnly) directory._writeStore = () => { throw Error('commit_outcome_unknown'); };
      directory.load(); loadStats();
    } else if (method === 'reload' || method === 'reconcile') {
      validateStore();
      const disk = JSON.parse(fs.readFileSync(options.storePath, 'utf8'));
      if (method === 'reconcile') {
        const checked = await reconfirmStoreAsync(options.storePath, args[0]);
        result = { outcome: checked.outcome };
      }
      directory = new Directory(options); directory.load();
      if (method === 'reconcile' && result.outcome === 'committed') await applyEffects(directory, args[0].effects || []);
    } else if (method === 'classifyCapturedIdentity') result = directory.classifyCapturedIdentity(...args);
    else if (method === 'saveStats') {
      mergeStats();
      for (const row of args[0]) {
        if (stats.get(row.id)?.principalFingerprint !== row.principalFingerprint) continue;
        if (!Number.isSafeInteger(row.totalRequests) || row.totalRequests < 0 || !Number.isFinite(row.lastUsedAt) || row.lastUsedAt < 0) throw Error('invalid_runtime_statistics');
        stats.set(row.id, { ...row });
      }
      const text = JSON.stringify({ schemaVersion: 1, accounts: [...stats.values()] });
      await atomicPrivateWriteAsync(statsFile, text); metrics.statsCommits++; metrics.bytes += Buffer.byteLength(text);
    } else if (method === 'close') {
      parentPort.postMessage({ id, ok: true, result: null }); parentPort.close(); return;
    } else result = await transact(id, method, args, expectedGeneration, expectedDigest);
    parentPort.postMessage({ id, ok: true, result, snapshot: snapshot(), revision });
  } catch (error) {
    if (prepared?.id === id && !['account_store_generation_conflict', 'account_store_locked'].includes(error.code)) error.code = 'account_store_commit_failed';
    parentPort.postMessage({ id, ok: false, error: safeError(error) });
  }
}
let serial = Promise.resolve();
parentPort.on('message', message => { serial = serial.then(() => command(message)); });
