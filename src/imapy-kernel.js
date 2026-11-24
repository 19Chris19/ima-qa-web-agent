'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { IMAWebProtocolClient } = require('../vendor/imapy-core');
const { mergeImaClientIdentity, requireImaClientIdentity } = require('./air/ima-client-identity');
const VERSION = 'imapy_chat_v1';
const fault = (code, statusCode = 409) => Object.assign(new Error(code), { code, statusCode });
function selection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(k => !['modelRef', 'mode'].includes(k)) || !/^[a-f0-9]{64}$/.test(value.modelRef || '') ||
      !['quick', 'deep'].includes(value.mode)) throw fault('model_selection_invalid', 400);
  return { modelRef: value.modelRef, mode: value.mode };
}
const clone = v => structuredClone(v);
// Provider stores a keyed base64url identity; the independent SDK requires hex.
// Keep Provider's persisted identity unchanged and derive only the protocol binding.
function protocolPrincipal(value){
 if(typeof value!=='string')return null;
 if(/^[a-f0-9]{64}$/.test(value))return value;
 if(!/^[A-Za-z0-9_-]{43}$/.test(value))return null;
 const bytes=Buffer.from(value,'base64url');if(bytes.length!==32||bytes.toString('base64url')!==value)return null;
 return createHash('sha256').update('provider-imapy-principal-v1\0'+value).digest('hex');
}

class ImapyKernel {
  constructor({ pool, enabled = false, policyPath = '', deviceContextPath = '', now = Date.now, deviceProvider,
    protocolFactory = opts => new IMAWebProtocolClient(opts) }) {
    this.pool = pool; this.enabled = enabled; this.policyPath = policyPath; this.now = now;
    this.deviceContexts = new Map();
    this.clientContexts = new Map();
    if (deviceContextPath) {
      try { const stat = fs.lstatSync(deviceContextPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.size > 256 * 1024) throw Error();
        const value = JSON.parse(fs.readFileSync(deviceContextPath));
        if (value.version !== 1 || !Array.isArray(value.accounts) || value.accounts.length > 500) throw Error();
        for (const item of value.accounts) {
          if (!protocolPrincipal(item.principalFingerprint) || this.deviceContexts.has(item.principalFingerprint) ||
              typeof item.deviceInfo?.uskey !== 'string' || !item.deviceInfo.uskey.length || item.deviceInfo.uskey.length > 4096 ||
              typeof item.deviceInfo.uskey_bus_infos_input !== 'string' || !item.deviceInfo.uskey_bus_infos_input.length || item.deviceInfo.uskey_bus_infos_input.length > 256) throw Error();
          this.deviceContexts.set(item.principalFingerprint, {uskey:item.deviceInfo.uskey,uskey_bus_infos_input:item.deviceInfo.uskey_bus_infos_input});
          if (item.clientIdentity !== undefined || item.userAgent !== undefined) {
            const identity = requireImaClientIdentity(item.clientIdentity);
            const q36 = identity['IMA-Q36'];
            if (typeof item.userAgent !== 'string' || item.userAgent.length > 512 ||
                identity['IMA-IUA'] !== item.userAgent.replace(/;/gu, ',') ||
                identity['IMA-GUID'] !== `guid-${q36}` ||
                !item.deviceInfo.uskey_bus_infos_input.startsWith(q36 + '_') ||
                !/^\d+$/u.test(item.deviceInfo.uskey_bus_infos_input.slice(q36.length + 1))) throw Error();
            this.clientContexts.set(item.principalFingerprint, { identity, userAgent: item.userAgent });
          }
        }
      } catch { this.deviceContexts.clear(); this.clientContexts.clear(); }
    }
    this.deviceProvider = deviceProvider || (a => this.deviceContexts.get(a.principalFingerprint) || a.client.deviceInfo || null);
    this.protocolFactory = protocolFactory; this.catalogs = new Map(); this.inflight = new Map();
    this.policy = { defaultModelRef: '', allowedModelRefs: [] }; this.policyReady = true;
    if (policyPath && fs.existsSync(policyPath)) {
      try { const st = fs.lstatSync(policyPath); if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o777) !== 0o600) throw Error();
        this.policy = this.validatePolicy(JSON.parse(fs.readFileSync(policyPath))); } catch { this.policyReady = false; }
    }
  }
  validatePolicy(v) {
    if (!v || !/^[a-f0-9]{64}$/.test(v.defaultModelRef || '') || !Array.isArray(v.allowedModelRefs) ||
        !v.allowedModelRefs.length || v.allowedModelRefs.length > 64 || v.allowedModelRefs.some(x => !/^[a-f0-9]{64}$/.test(x)) ||
        !v.allowedModelRefs.includes(v.defaultModelRef)) throw fault('model_policy_invalid', 400);
    return { defaultModelRef: v.defaultModelRef, allowedModelRefs: [...new Set(v.allowedModelRefs)] };
  }
  setPolicy(value) {
    const next = this.validatePolicy(value);
    const models = new Set([...this.catalogs.values()].filter(x => x.expiresAt > this.now()).flatMap(x => x.catalog.models.map(m => m.modelRef)));
    if (![...this.catalogs.values()].some(c => c.expiresAt > this.now() && c.catalog.models.some(m => m.modelRef === next.defaultModelRef && m.modes.quick))) throw fault('model_default_quick_unavailable');
    if (next.allowedModelRefs.some(x => !models.has(x))) throw fault('model_policy_catalog_unproved');
    if (!this.policyPath) throw fault('model_policy_storage_unavailable', 503);
    fs.mkdirSync(path.dirname(this.policyPath), { recursive: true, mode: 0o700 });
    const temp = this.policyPath + '.' + randomUUID(); let fd;
    try { fd = fs.openSync(temp, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify(next)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temp, this.policyPath); fd = fs.openSync(path.dirname(this.policyPath), 'r'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      this.policy = next; this.policyReady = true; return clone(next);
    } catch { this.policyReady = false; throw fault('model_policy_storage_unavailable', 503); }
    finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  key(account) { return createHash('sha256').update(JSON.stringify([account.id, account.principalFingerprint, account.client.credentialGeneration, account.client.headers])).digest('hex'); }
  baseEligible(a) { return !a.disabled && !a.maintenanceOperation && this.pool.persistenceReady?.() !== false &&
    !a.client.pendingCredentialPersistence && !a.client.credentialWritesSuspended && (!this.pool.webReadiness || this.pool.webReadiness(a)); }
  device(a) { const d = this.deviceProvider(a); return d && typeof d.uskey === 'string' && d.uskey.length && typeof d.uskey_bus_infos_input === 'string' && d.uskey_bus_infos_input.length ? d : null; }
  protocolHeaders(account) {
    const headers = { ...account.client.headers, extension_version: '' };
    const context = this.clientContexts.get(account.principalFingerprint);
    if (context) {
      headers['x-ima-cookie'] = mergeImaClientIdentity(headers['x-ima-cookie'], context.identity);
      headers['user-agent'] = context.userAgent;
    }
    return headers;
  }
  async catalog(a, signal) {
    const key = this.key(a), cached = this.catalogs.get(a.id);
    if (cached?.key === key && cached.expiresAt > this.now()) return cached.catalog;
    // The bounded shared read owns its timeout; cancelling one browser does not cancel another caller.
    if (!this.inflight.has(key)) {
      const pending = (async () => {
        const p = this.protocolFactory({ headers: this.protocolHeaders(a), now: this.now,
          fetchImpl: (u, o) => a.client._fetch(u, o) });
        const catalog = await p.getModels({ signal: AbortSignal.timeout(10000) });
        if (this.key(a) !== key || !this.pool.accounts.includes(a)) throw fault('model_catalog_stale');
        this.catalogs.set(a.id, { key, catalog, expiresAt: this.now() + 300000 }); return catalog;
      })().finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    const value = await this.inflight.get(key); signal?.throwIfAborted(); return value;
  }
  supports(a, value, web, allowExpired = false) {
    if (!this.enabled || !this.policyReady || !this.baseEligible(a) || !this.device(a) || !protocolPrincipal(a.principalFingerprint)) return false;
    const cached = this.catalogs.get(a.id);
    if (!cached || cached.key !== this.key(a) || (!allowExpired && cached.expiresAt <= this.now())) return false;
    const m = cached.catalog.models.find(m => m.modelRef === value.modelRef), info = m?.modes[value.mode];
    return Boolean(this.policy.allowedModelRefs.includes(value.modelRef) && info && (!web || info.enable_enhancement));
  }
  async capabilities({ upstream = {}, signal } = {}) {
    if (!this.enabled) return { version: VERSION, enabled: false, models: [], reason: 'kernel_disabled' };
    if (upstream.sessionId && upstream.kernelVersion !== VERSION) return { version: VERSION, enabled: true, legacy: true, models: [], reason: 'legacy_session' };
    for (const id of this.catalogs.keys()) if (!this.pool.accounts.some(a => a.id === id)) this.catalogs.delete(id);
    const accounts = this.pool.accounts.filter(a => this.baseEligible(a) && (!upstream.accountId || a.id === upstream.accountId));
    for (const a of accounts) { if (!a.activeRequests) { try { await this.catalog(a, signal); } catch {} } }
    const found = new Map(); const reasons = new Set();
    for (const a of accounts) {
      const c = this.catalogs.get(a.id); if (!c || c.key !== this.key(a) || c.expiresAt <= this.now()) { reasons.add('catalog_unavailable'); continue; }
      if(!protocolPrincipal(a.principalFingerprint)){reasons.add('principal_unproved');continue;}
      if (!this.device(a)) { reasons.add('device_context_missing'); continue; }
      for (const m of c.catalog.models) {
        if (!this.policyReady || !this.policy.allowedModelRefs.includes(m.modelRef)) continue;
        const row = found.get(m.modelRef) || { modelRef: m.modelRef, name: m.name, modes: {} };
        for (const [mode, info] of Object.entries(m.modes)) row.modes[mode] = { webSearch: Boolean(row.modes[mode]?.webSearch || info.enable_enhancement) };
        found.set(m.modelRef, row);
      }
    }
    return { version: VERSION, enabled: true, defaultSelection: upstream.kernelCheckpoint?.selection ? { modelRef: upstream.kernelCheckpoint.selection.modelRef, mode: upstream.kernelCheckpoint.selection.mode } : this.policy.defaultModelRef ? { modelRef: this.policy.defaultModelRef, mode: 'quick' } : null,
      models: [...found.values()], reason: !this.policyReady ? 'policy_unavailable' : !this.policy.defaultModelRef ? 'default_not_configured' : !found.has(this.policy.defaultModelRef) ? 'default_unavailable' : null,
      ...(found.size ? {} : { unavailableReasons: [...reasons] }) };
  }
  accountStatus(a) {
    const c=this.catalogs.get(a.id),contextReady=Boolean(this.device(a));
    const catalogCurrent=Boolean(c&&c.key===this.key(a)&&c.expiresAt>this.now());
    const reason=!this.enabled?'kernel_disabled':!this.policyReady?'policy_unavailable':!this.baseEligible(a)?'account_unavailable':!protocolPrincipal(a.principalFingerprint)?'principal_unproved':!contextReady?'device_context_missing':!catalogCurrent?'catalog_unavailable':!this.policy.defaultModelRef?'default_not_configured':!this.supports(a,{modelRef:this.policy.defaultModelRef,mode:'quick'},false)?'default_unavailable':null;
    return {enabled:this.enabled,contextReady,catalogCurrent,ready:reason===null,reason};
  }
  adminStatus() {
    return { version: VERSION, enabled: this.enabled, policyReady: this.policyReady, policy: clone(this.policy),
      accounts: this.pool.accounts.map(a => { const c = this.catalogs.get(a.id); return { accountId: a.id,
        contextReady: Boolean(this.device(a)), catalogCurrent: Boolean(c && c.key === this.key(a) && c.expiresAt > this.now()),
        models: c?.catalog.models.map(m => ({ modelRef: m.modelRef, name: m.name, modes: Object.keys(m.modes) })) || [] }; }) };
  }
  async prepare(upstream = {}, signal) {
    if (!this.enabled) throw fault('model_kernel_unavailable');
    for (const a of this.pool.accounts.filter(a => this.baseEligible(a) && (!upstream.accountId || a.id === upstream.accountId))) {
      try { await this.catalog(a, signal); } catch { /* No credentials are refreshed; admission validates the result. */ }
    }
  }
  validateRequest(value, upstream, web) {
    const s = selection(value);
    if (upstream.sessionId && upstream.kernelVersion !== VERSION) throw fault('legacy_session_model_selection_unavailable');
    if (!this.enabled || !this.policyReady) throw fault('model_kernel_unavailable');
    if (!this.pool.accounts.some(a => (!upstream.accountId || a.id === upstream.accountId) && this.supports(a, s, web))) throw fault('model_selection_unavailable');
    return s;
  }
  async *stream(a, options) {
    const selected = selection(options.modelSelection), key = this.key(a), signal = options.signal;
    const web = options.sourceIntent === 'web_requested';
    await this.catalog(a, signal);
    if (!this.supports(a, selected, web)) throw fault('model_selection_unavailable');
    const principal=protocolPrincipal(a.principalFingerprint);if(!principal)throw fault('model_principal_unproved');
    const modelCatalog = this.catalogs.get(a.id).catalog;
    // getModels is fed through a cache-only adapter below; no additional model HTTP request per turn.
    const headers = this.protocolHeaders(a);
    const fetchImpl = async (url, request) => {
      if (this.key(a) !== key || !this.baseEligible(a)) throw fault('credential_generation_stale');
      if (new URL(url).pathname === '/cgi-bin/model_manage/get_models') {
        const models = modelCatalog.models.map(m => ({ model_name: m.name, is_default: m.isDefault, ...m.base,
          sub_model_infos: Object.fromEntries(Object.entries(m.modes).map(([k,v]) => [k === 'quick' ? '0' : '1', v])),
          sub_model_types: Object.fromEntries(Object.entries(m.modes).map(([k,v]) => [k === 'quick' ? '0' : '1', v.model_type])) }));
        return new Response(JSON.stringify({ code: 0, models, version: modelCatalog.version }));
      }
      if (new URL(url).pathname === '/cgi-bin/assistant/qa') options.onDispatch?.();
      return a.client._fetch(url, { ...request, ...(options.transportTimeouts ? { transportTimeouts: options.transportTimeouts } : {}), onActivity: options.onActivity });
    };
    const client = this.protocolFactory({ headers, deviceInfo: this.device(a), principalFingerprint: principal, now: this.now, fetchImpl });
    await client.getModels({ signal });
    const catalog = await client.listKnowledgeBases({ signal });
    const library = client.selectKnowledgeBase({ catalog, knowledgeBaseId: a.knowledgeBaseId || a.client.knowledgeBaseId });
    let session;
    if (options.kernelCheckpoint) {
      if (options.kernelVersion !== VERSION || options.kernelCheckpoint.sessionId !== options.sessionId) throw fault('kernel_session_conflict');
      const history = await client.getScopedAgentSessionHistory({ sessionId: options.sessionId, knowledgeBaseId: library.knowledgeBaseId, library, signal });
      session = client.restoreScopedAgentSession({ history, checkpoint: options.kernelCheckpoint, library });
      session = client.configureScopedAgentSession({ session, ...selected, webSearch: web });
    } else {
      if (options.sessionId) throw fault('kernel_session_conflict');
      session = await client.createScopedAgentSession({ library, ...selected, webSearch: web, signal });
    }
    const checkpoint = client.getScopedAgentCheckpoint({ session });
    options.onKernelCheckpoint?.({ kernelVersion: VERSION, kernelCheckpoint: checkpoint, sessionId: session.sessionId, sessionAnswerProfile: 'ima_agent_auto' });
    options.onSession?.(session.sessionId, { answerProfile: 'ima_agent_auto' });
    const name = modelCatalog.models.find(m => m.modelRef === selected.modelRef).name;
    const modelSelection = { ...selected, name, kernelVersion: VERSION, reported: null };
    yield { type: 'selection', modelSelection };
    for await (const event of client.streamAsk({ session, question: options.question, clientId: options.requestId || randomUUID(), signal, timeoutMs: null,
      onCheckpoint: saved => { if (this.key(a) !== key) throw fault('credential_generation_stale');
        options.onKernelCheckpoint?.({ kernelVersion: VERSION, kernelCheckpoint: saved, sessionId: session.sessionId, sessionAnswerProfile: 'ima_agent_auto' }); return { committed: true }; } })) {
      if (this.key(a) !== key) throw fault('credential_generation_stale');
      if (event.type === 'done') yield { ...event, modelSelection }; else yield event;
    }
  }
}
module.exports = { ImapyKernel, selection, VERSION };
