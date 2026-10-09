'use strict';

const crypto = require('node:crypto');
const { IMAWebAgentClient: BaseClient } = require('../ima-web-agent-client');
const { buildIMAInitSessionBody, buildIMAQuestionBody, normalizeAnswerProfile } = require('../ima-answer-profile');
const { buildIMAKnowledgeAgentHeaders, buildIMAKnowledgeAgentRequest, classifyIMAKnowledgeAgentSource } = require('../ima-knowledge-agent-contract');
const { parseIMAWebAgentStream } = require('../ima-upstream-protocol');
const { normalizeTransportTimeouts } = require('../task-transport');
const { mergeImaClientIdentity, requireImaClientIdentity } = require('./ima-client-identity');
const { buildRecentContextQuestionPlan } = require('../bot-recent-context');

const BASE = 'https://ima.qq.com';
const policyProfile = policy => ['knowledge_agent', 'group_knowledge'].includes(policy)
  ? 'classic_knowledge' : 'ima_agent_auto';

class IMAWebAgentClient extends BaseClient {
  constructor(config, fetchImpl = globalThis.fetch) {
    super(config, fetchImpl);
    this.answerProfile = normalizeAnswerProfile(config.answerProfile || 'classic_knowledge');
    this.clientContextProvider = config.clientContextProvider || null;
    this.allowAuthRefresh = config.allowAuthRefresh !== false;
    this.protocolObserver = config.protocolObserver;
    this.protocolUnknownObserver = config.protocolUnknownObserver;
    this.protocolNormalizationObserver = config.protocolNormalizationObserver;
    this.protocolErrorObserver = config.protocolErrorObserver;
    this.sourceClassifier = config.sourceClassifier;
  }

  applyConfig(config = {}) {
    super.applyConfig(config);
    if (config.answerProfile) this.answerProfile = normalizeAnswerProfile(config.answerProfile);
  }

  getConfigSnapshot() { return { ...super.getConfigSnapshot(), answerProfile: this.answerProfile }; }

  async ensureFreshAuth(options = {}) {
    if (!this.allowAuthRefresh || options.allowAuthRefresh === false) return false;
    return super.ensureFreshAuth(options);
  }

  startAutoRefresh(callback) { return this.allowAuthRefresh ? super.startAutoRefresh(callback) : null; }

  async getFirstPartyClientContext(options = {}) {
    if (!this.clientContextProvider?.get) throw Object.assign(new Error('ima_client_context_unavailable'), { code: 'ima_client_context_unavailable' });
    return this.clientContextProvider.get(this.getConfigSnapshot(), options);
  }

  async _initSessionOnce(options = {}) {
    if (!options.answerProfile || options.mode === 'knowledge_agent') return super._initSessionOnce(options);
    const response = await this._fetch(`${BASE}/cgi-bin/session_logic/init_session`, {
      method: 'POST', headers: this.profileHeaders(options.answerProfile, options.clientContext),
      body: JSON.stringify(buildIMAInitSessionBody(options.answerProfile, this.knowledgeBaseId, options)),
      signal: options.signal, transportTimeouts: options.transportTimeouts,
    });
    try {
      if (!response.ok) throw Object.assign(new Error('upstream_session_failed'), { code: 'upstream_session_failed' });
      return await response.json();
    } finally { response.closeTransport?.(); }
  }

  async *streamAsk(options = {}) {
    const { signal, recentContext, retrievalPolicy = '', onRecentContextPlan, onSession } = options;
    signal?.throwIfAborted();
    const native = retrievalPolicy === 'knowledge_agent' || options.mode === 'knowledge_agent';
    if (retrievalPolicy === 'knowledge_agent' && options.mode && options.mode !== 'knowledge_agent') {
      throw Object.assign(new Error('retrieval_mode_conflict'), { code: 'retrieval_mode_conflict' });
    }
    if (retrievalPolicy && !['knowledge_agent', 'group_knowledge', 'auto', 'web', 'mixed'].includes(retrievalPolicy)) {
      throw Object.assign(new Error('retrieval_policy_invalid'), { code: 'retrieval_policy_invalid' });
    }
    if (options.mode === 'knowledge_agent' && retrievalPolicy && retrievalPolicy !== 'knowledge_agent') {
      throw Object.assign(new Error('retrieval_mode_conflict'), { code: 'retrieval_mode_conflict' });
    }
    const profile = native ? 'classic_knowledge' : normalizeAnswerProfile(
      retrievalPolicy ? policyProfile(retrievalPolicy) : options.answerProfile || options.sessionAnswerProfile || this.answerProfile);
    if (options.sessionId && options.sessionAnswerProfile && options.sessionAnswerProfile !== profile) {
      throw Object.assign(new Error('session_profile_conflict'), { code: 'session_profile_conflict' });
    }
    const plan = recentContext ? buildRecentContextQuestionPlan(options.question, recentContext, retrievalPolicy) : null;
    if (plan) onRecentContextPlan?.(plan);
    const question = plan?.question || options.question;
    if (typeof question !== 'string' || !question.trim() || Array.from(question).length > 18000) {
      throw Object.assign(new Error('question_invalid'), { code: 'question_invalid' });
    }
    const transportTimeouts = options.transportTimeouts || signal?.transportTimeouts;
    const timeouts = transportTimeouts ? normalizeTransportTimeouts(transportTimeouts) : undefined;
    const allowAuthRefresh = this.allowAuthRefresh && options.allowAuthRefresh !== false;
    await this.ensureFreshAuth({ signal, allowAuthRefresh, transportTimeouts: timeouts });
    const clientContext = profile === 'ima_agent_auto' ? await this.getFirstPartyClientContext({ signal }) : null;
    const mode = native ? 'knowledge_agent' : options.mode || 'classic_knowledge';
    const sessionId = options.sessionId || await this.initSession({ signal, mode, answerProfile: profile,
      clientContext, allowAuthRefresh, transportTimeouts: timeouts, sessionName: options.originalQuestion || options.question });
    onSession?.(sessionId, { answerProfile: profile });
    // No expired-session replay and no knowledge-first second QA request.
    yield* this.streamProfileOnce({ ...options, originalQuestion: options.originalQuestion || (plan ? options.question : undefined), question, sessionId, mode, answerProfile: profile,
      clientContext, transportTimeouts: timeouts });
  }

  async *streamProfileOnce(options) {
    const { signal, mode, answerProfile, clientContext, question, sessionId, retrievalPolicy = '' } = options;
    const common = { question: options.originalQuestion || question.slice(0, 2000), sessionId,
      knowledgeBaseId: this.knowledgeBaseId, clientId: crypto.randomUUID(), modelId: this.modelId,
      modelType: this.modelType, deviceInfo: clientContext?.deviceInfo, retrievalPolicy };
    const body = { ...(mode === 'knowledge_agent' ? buildIMAKnowledgeAgentRequest(common) : buildIMAQuestionBody(answerProfile, common)), question };
    signal?.throwIfAborted();
    options.onDispatch?.();
    const response = await this._fetch(`${BASE}/cgi-bin/assistant/qa`, {
      method: 'POST', headers: mode === 'knowledge_agent'
        ? buildIMAKnowledgeAgentHeaders(this.headers, { knowledgeBaseId: this.knowledgeBaseId })
        : this.profileHeaders(answerProfile, clientContext),
      body: JSON.stringify(body), signal, transportTimeouts: options.transportTimeouts, onActivity: options.onActivity,
    });
    try {
      if (!response.ok) throw Object.assign(new Error('upstream_http_failure'), { code: 'upstream_http_failure', statusCode: 502 });
      for await (const event of parseIMAWebAgentStream(response, {
        onEventDescriptor: this.protocolObserver, onUnknownEventDescriptor: this.protocolUnknownObserver,
        onNormalizationDiagnostic: this.protocolNormalizationObserver,
        sourceClassifier: mode === 'knowledge_agent' ? (item, context = {}) => classifyIMAKnowledgeAgentSource(item, {
          expectedKnowledgeScopeRef: crypto.createHash('sha256').update(this.knowledgeBaseId).digest('hex'),
          sourceEventName: typeof context === 'string' ? context : context.sourceEventName || context.eventName || '',
        }).kind : this.sourceClassifier,
      })) yield { ...event, answerProfile };
    } catch (error) {
      try { this.protocolErrorObserver?.(error.code); } catch { /* Telemetry cannot fail QA. */ }
      if (signal?.aborted) throw signal.reason || error;
      throw response.transportError || error;
    } finally { response.closeTransport?.(); }
  }

  profileHeaders(profile, context) {
    if (profile !== 'ima_agent_auto') return super._headers();
    const cookie = this.headers['x-ima-cookie'] || this.headers.cookie || '';
    const identity = requireImaClientIdentity(context?.identity);
    const merged = mergeImaClientIdentity(cookie, identity);
    return { ...super._headers(), ...this.headers, 'x-ima-cookie': merged,
      ...(this.headers.cookie ? { cookie: merged } : {}), referer: `${BASE}/`,
      extension_version: identity['WEB-VERSION'], 'user-agent': context.userAgent };
  }
}

module.exports = { IMAWebAgentClient, policyProfile };
