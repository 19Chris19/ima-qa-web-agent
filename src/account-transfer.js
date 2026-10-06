const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parseRuntimeEnvText, getImaPrincipalId, normalizeAccountId } = require('./web-agent-account-directory');
const { buildRuntimeEnvText } = require('./ima-web-agent-client');
const { auditHistoryInput, adaptHistoryInput } = require('./history-export-preflight');

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const keyBytes = value => crypto.createHash('sha256').update(String(value).trim()).digest();
const failure = code => Object.assign(new Error(code), { code });

function privateRead(file, limit = 32 * 1024 * 1024) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > limit) throw failure('transfer_input_invalid');
  return fs.readFileSync(file, 'utf8');
}

function readSnapshot(storePath, keyPath) {
  try {
    const raw = privateRead(storePath);
    const key = privateRead(keyPath, 4096).trim();
    const store = JSON.parse(raw);
    if (!key || store.version !== 1 || !Array.isArray(store.accounts) || store.accounts.length > 5000) {
      throw failure('transfer_store_unsupported');
    }
    return { raw, key, store, hash: digest(raw) };
  } catch { throw failure('transfer_snapshot_unreadable'); }
}

function decryptAccount(account, key) {
  try {
    if (account.secret?.alg !== 'aes-256-gcm') throw new Error();
    const iv = Buffer.from(account.secret.iv, 'base64');
    const tag = Buffer.from(account.secret.tag, 'base64');
    if (iv.length !== 12 || tag.length !== 16) throw new Error();
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes(key), iv);
    decipher.setAuthTag(tag);
    const text = Buffer.concat([decipher.update(Buffer.from(account.secret.ciphertext, 'base64')), decipher.final()]).toString('utf8');
    const config = parseRuntimeEnvText(text);
    const principal = getImaPrincipalId(config.headers);
    if (!principal || config.knowledgeBaseId !== account.knowledgeBaseId) throw new Error();
    return { config, principal };
  } catch { throw failure('transfer_identity_unverified'); }
}

function encryptAccount(text, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBytes(key), iv);
  const ciphertext = Buffer.concat([cipher.update(text), cipher.final()]);
  return { alg: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}

function accountAliases(account) {
  if (typeof account.id !== 'string' || !account.id || normalizeAccountId(account.id) !== account.id ||
      typeof account.name !== 'string' || !account.name || account.name.replace(/\s+/g, ' ').trim().slice(0, 80) !== account.name) {
    throw failure('transfer_account_namespace_conflict');
  }
  return new Set([account.id, account.name, normalizeAccountId(account.name)]);
}

function validateAccountNamespace(accounts) {
  const reserved = new Set();
  for (const account of accounts) {
    const aliases = accountAliases(account);
    if ([...aliases].some(alias => reserved.has(alias))) throw failure('transfer_account_namespace_conflict');
    for (const alias of aliases) reserved.add(alias);
  }
  return reserved;
}

function uniqueLabel(base, reserved, limit) {
  let label = base;
  for (let suffix = 1; reserved.has(label) || reserved.has(normalizeAccountId(label)); suffix++) {
    const ending = `-migrated-${suffix}`;
    label = base.slice(0, limit - ending.length) + ending;
  }
  return label;
}

function buildTransfer({ source, target, knowledgeBaseId, now = new Date().toISOString() }) {
  if (!/^\d+$/.test(knowledgeBaseId || '')) throw failure('transfer_scope_required');
  const targetAccounts = target.store.accounts;
  const identities = new Set();
  const reserved = validateAccountNamespace(targetAccounts);
  for (const account of targetAccounts) {
    if (account.knowledgeBaseId !== knowledgeBaseId) throw failure('transfer_target_conflict');
    const { principal } = decryptAccount(account, target.key);
    if (identities.has(principal)) throw failure('transfer_target_duplicate_identity');
    identities.add(principal);
  }
  const additions = [];
  let duplicates = 0;
  for (const account of source.store.accounts) {
    if (account.knowledgeBaseId !== knowledgeBaseId) throw failure('transfer_scope_mismatch');
    const { principal, config } = decryptAccount(account, source.key);
    if (identities.has(principal)) { duplicates++; continue; }
    identities.add(principal);
    const id = uniqueLabel(normalizeAccountId(account.id), reserved, 80);
    const name = uniqueLabel(String(account.name || id).replace(/\s+/g, ' ').trim().slice(0, 64) || id, reserved, 80);
    for (const alias of accountAliases({ id, name })) reserved.add(alias);
    // Drop old capability proofs, machine paths and transient scheduling state across installations.
    const runtime = {
      disabled: true, disabledReason: 'migration_verification_required', activeRequests: 0,
      cooldownUntil: 0, consecutiveErrors: 0, totalRequests: 0,
      tokenExpiresAt: account.runtime?.tokenExpiresAt || config.tokenExpiresAt,
      refreshTokenExpiresAt: account.runtime?.refreshTokenExpiresAt || config.refreshTokenExpiresAt,
      refreshSkewMs: account.runtime?.refreshSkewMs ?? config.refreshSkewMs,
      refreshIntervalMs: account.runtime?.refreshIntervalMs ?? config.refreshIntervalMs,
      hasRefreshCredentials: /(?:^|;\s*)IMA-REFRESH-TOKEN=/.test(config.headers['x-ima-cookie']),
      webQualification: null, knowledgeAgentQualification: null,
    };
    const text = buildRuntimeEnvText({ accountId: id, accountName: name, knowledgeBaseId,
      headers: config.headers, modelId: config.modelId, modelType: config.modelType,
      ...runtime, runtimeEnvPath: '' });
    additions.push({ id, name, knowledgeBaseId, modelId: config.modelId, modelType: config.modelType,
      runtimeEnvPath: '', source: 'offline-transfer', createdAt: now, updatedAt: now,
      principalFingerprint: crypto.createHmac('sha256', keyBytes(target.key)).update(`ima-principal:${principal}`).digest('base64url'),
      runtime, events: [], secret: encryptAccount(text, target.key) });
  }
  return {
    report: { sourceAccounts: source.store.accounts.length, targetAccounts: targetAccounts.length,
      duplicateIdentities: duplicates, newIdentities: additions.length,
      resultingIdentities: identities.size, importedEnabledAccounts: 0, credentialsVerifiedOnline: false,
      sourceOwnershipTransferred: false },
    candidate: { ...structuredClone(target.store), updatedAt: now,
      accounts: [...structuredClone(targetAccounts), ...additions] },
    sourceHash: source.hash, targetHash: target.hash,
  };
}

function exportHistory(store) {
  return exportHistoryWithReport(store).archive;
}

function exportHistoryWithReport(store, options = {}) {
  const { report, conversations } = adaptHistoryInput(store, options);
  if (!report.ready) throw Object.assign(failure('archive_preflight_failed'), { report });
  const ids = new Set();
  const archive = { schemaVersion: 1, conversations: conversations.map(row => {
    if (!row || typeof row.id !== 'string' || !row.id || ids.has(row.id) ||
        typeof row.ownerKey !== 'string' || !/^[a-z0-9._:-]{1,160}$/i.test(row.ownerKey) || !Array.isArray(row.turns)) {
      throw failure('archive_ownership_invalid');
    }
    ids.add(row.id);
    return { id: row.id, ownerKey: row.ownerKey, title: row.title || '', mode: row.mode,
      createdAt: row.createdAt, updatedAt: row.updatedAt, expiresAt: row.expiresAt,
      turns: row.turns.map(turn => {
        if (typeof turn.question !== 'string' || typeof turn.answer !== 'string') throw failure('archive_turn_invalid');
        return { question: turn.question, answer: turn.answer, createdAt: turn.createdAt,
          sources: Array.isArray(turn.sources) ? turn.sources.map(exportSource) : [],
          searchSummary: turn.searchSummary ?? null,
          evidence: turn.evidence ? exportEvidence(turn.evidence) : undefined };
      }) };
  }) };
  if (Buffer.byteLength(JSON.stringify(archive)) > 16 * 1024 * 1024) {
    throw Object.assign(failure('archive_preflight_failed'), {
      report: { ...report, ready: false, reasons: { size_limit: 1 } },
    });
  }
  return { archive, report };
}

function exportSource(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw failure('archive_source_invalid');
  // Consumer schema v1 (6237d8a) accepts type, never the upstream sourceType key.
  const result = Object.fromEntries(['index', 'title', 'url', 'snippet', 'type']
    .filter(key => key in source).map(key => [key, source[key]]));
  if (result.type === undefined && [0, 1, 2].includes(source.sourceType)) {
    result.type = source.sourceType === 0 ? 'web' : 'knowledge';
  }
  return result;
}

function exportEvidence(evidence) {
  const result = Object.fromEntries(['source_intent', 'answer_basis', 'source_count', 'knowledge_source_count', 'web_source_count',
    'complete', 'interrupted', 'timing', 'process']
    .filter(key => key in evidence).map(key => [key, evidence[key]]));
  if (result.source_intent === undefined && ['', 'web_requested'].includes(evidence.sourceIntent)) {
    result.source_intent = evidence.sourceIntent;
  }
  return result;
}

function prepareTransfer({ sourceStore, sourceKey, targetStore, targetKey, knowledgeBaseId, output, historyStore }) {
  // Check the real parent, not a lexical alias into a repository subdirectory.
  const requested = path.resolve(output);
  const out = path.join(fs.realpathSync(path.dirname(requested)), path.basename(requested));
  for (let dir = out; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) throw failure('transfer_output_must_be_private');
    if (dir === path.dirname(dir)) break;
  }
  const source = readSnapshot(sourceStore, sourceKey);
  const target = readSnapshot(targetStore, targetKey);
  const transfer = buildTransfer({ source, target, knowledgeBaseId });
  const archive = historyStore ? exportHistory(JSON.parse(privateRead(historyStore))) : null;
  // Re-read before emitting the bundle; a running writer invalidates this preparation.
  if (digest(privateRead(sourceStore)) !== source.hash || digest(privateRead(targetStore)) !== target.hash) {
    throw failure('transfer_snapshot_changed');
  }
  fs.mkdirSync(out, { mode: 0o700 });
  const write = (name, body) => fs.writeFileSync(path.join(out, name), body, { mode: 0o600, flag: 'wx' });
  write('source.accounts.json', source.raw); write('target.accounts.json', target.raw);
  write('source.key', source.key); write('target.key', target.key);
  const candidate = JSON.stringify(transfer.candidate, null, 2);
  write('candidate.accounts.json', candidate);
  if (archive) write('history.archive.json', JSON.stringify(archive));
  write('manifest.json', JSON.stringify({ schemaVersion: 1, state: 'prepared_not_applied',
    sourceHash: source.hash, targetHash: target.hash, candidateHash: digest(candidate), report: transfer.report }, null, 2));
  return { ...transfer.report, state: 'prepared_not_applied', archivedConversations: archive?.conversations.length || 0 };
}

module.exports = { readSnapshot, buildTransfer, prepareTransfer, exportHistory, exportHistoryWithReport,
  auditHistoryInput, decryptAccount, validateAccountNamespace };
