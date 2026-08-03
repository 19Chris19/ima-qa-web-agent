const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_CONVERSATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_CONVERSATION_MAX_TURNS = 12;
const DEFAULT_CONVERSATION_MAX_COUNT = 5000;
const DEFAULT_CONVERSATION_LIST_LIMIT = 50;
const MAX_PERSISTED_SOURCES = 10;
const MAX_SOURCE_TITLE_LENGTH = 240;
const MAX_SOURCE_SNIPPET_LENGTH = 800;
const MAX_SEARCH_SUMMARY_LENGTH = 280;

class ConversationNotFoundError extends Error {
  constructor() {
    super('会话不存在或已过期，请新建会话后继续');
    this.name = 'ConversationNotFoundError';
    this.statusCode = 404;
  }
}

class ConversationBusyError extends Error {
  constructor() {
    super('这个会话上一条消息还在处理中，请稍后再试');
    this.name = 'ConversationBusyError';
    this.statusCode = 409;
  }
}

class ConversationStore {
  constructor(options = {}) {
    this.storePath = options.storePath ? path.resolve(options.storePath) : '';
    this.persist = options.persist !== false && Boolean(this.storePath);
    this.ttlMs = positiveNumber(options.ttlMs, DEFAULT_CONVERSATION_TTL_MS);
    this.maxTurns = positiveNumber(options.maxTurns, DEFAULT_CONVERSATION_MAX_TURNS);
    this.maxCount = positiveNumber(options.maxCount, DEFAULT_CONVERSATION_MAX_COUNT);
    this.now = options.now || (() => Date.now());
    this.conversations = new Map();
    this.loaded = false;
    this.load();
  }

  load() {
    if (this.loaded) {
      return this;
    }
    this.loaded = true;
    if (!this.persist || !fs.existsSync(this.storePath)) {
      return this;
    }

    const parsed = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
    const items = Array.isArray(parsed?.conversations) ? parsed.conversations : [];
    for (const item of items) {
      const conversation = normalizeConversation(item);
      if (conversation && conversation.expiresAt > this.now()) {
        this.conversations.set(conversation.id, conversation);
      }
    }
    this._trimToLimit();
    return this;
  }

  create(ownerKey = '') {
    this._removeExpired();
    const now = this.now();
    const conversation = {
      id: crypto.randomUUID(),
      ownerKey: cleanText(ownerKey),
      createdAt: now,
      updatedAt: now,
      expiresAt: now + this.ttlMs,
      title: '',
      turns: [],
      upstream: {
        accountId: '',
        sessionId: '',
      },
      activeRequest: false,
    };
    this.conversations.set(conversation.id, conversation);
    this._trimToLimit();
    this._write();
    return this.publicState(conversation);
  }

  require(id, ownerKey = '') {
    this._removeExpired();
    const conversation = this.conversations.get(String(id || '').trim());
    if (!conversation || conversation.ownerKey !== cleanText(ownerKey)) {
      throw new ConversationNotFoundError();
    }
    return conversation;
  }

  beginRequest(id, ownerKey = '') {
    const conversation = this.require(id, ownerKey);
    if (conversation.activeRequest) {
      throw new ConversationBusyError();
    }
    conversation.activeRequest = true;
    return conversation;
  }

  endRequest(id, ownerKey = '') {
    const conversation = this.conversations.get(String(id || '').trim());
    if (!conversation || conversation.ownerKey !== cleanText(ownerKey)) {
      return false;
    }
    conversation.activeRequest = false;
    return true;
  }

  setUpstream(id, upstream = {}, ownerKey = '') {
    const conversation = this.require(id, ownerKey);
    conversation.upstream = {
      accountId: cleanText(upstream.accountId),
      sessionId: cleanText(upstream.sessionId),
    };
    this.touch(conversation);
    this._write();
    return this.publicState(conversation);
  }

  clearUpstream(id, ownerKey = '') {
    return this.setUpstream(id, {}, ownerKey);
  }

  getUpstream(id, ownerKey = '') {
    const conversation = this.require(id, ownerKey);
    return {
      accountId: conversation.upstream.accountId,
      sessionId: conversation.upstream.sessionId,
    };
  }

  appendTurn(id, question, answer, metadataOrOwnerKey = {}, ownerKey = '') {
    const { metadata, resolvedOwnerKey } = normalizeAppendTurnArguments(metadataOrOwnerKey, ownerKey);
    const conversation = this.require(id, resolvedOwnerKey);
    const now = this.now();
    const normalizedQuestion = truncate(question, 2000);
    conversation.turns.push({
      question: normalizedQuestion,
      answer: truncate(answer, 8000),
      createdAt: now,
      sources: normalizePublicSources(metadata.sources, answer),
      searchSummary: normalizeSearchSummary(metadata.searchSummary),
    });
    if (!conversation.title) {
      conversation.title = conversationTitle(normalizedQuestion);
    }
    conversation.turns = conversation.turns.slice(-this.maxTurns);
    this.touch(conversation, now);
    this._write();
    return this.publicState(conversation);
  }

  getHistory(id, ownerKey = '') {
    const conversation = this.require(id, ownerKey);
    return conversation.turns.flatMap((turn) => [
      { role: 'user', content: turn.question },
      { role: 'assistant', content: turn.answer },
    ]);
  }

  list(ownerKey = '', options = {}) {
    this._removeExpired();
    const limit = boundedLimit(options.limit, DEFAULT_CONVERSATION_LIST_LIMIT);
    return [...this.conversations.values()]
      .filter((conversation) => conversation.ownerKey === cleanText(ownerKey))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, limit)
      .map((conversation) => this.publicSummary(conversation));
  }

  getDetail(id, ownerKey = '') {
    const conversation = this.require(id, ownerKey);
    return {
      conversation: this.publicState(conversation),
      messages: conversation.turns.flatMap((turn) => [
        {
          role: 'user',
          content: turn.question,
          createdAt: new Date(turn.createdAt).toISOString(),
        },
        {
          role: 'assistant',
          content: turn.answer,
          createdAt: new Date(turn.createdAt).toISOString(),
          ...(turn.sources?.length ? { sources: turn.sources } : {}),
          ...(turn.searchSummary ? { searchSummary: turn.searchSummary } : {}),
        },
      ]),
    };
  }

  touch(conversation, now = this.now()) {
    conversation.updatedAt = now;
    conversation.expiresAt = now + this.ttlMs;
  }

  delete(id, ownerKey = '') {
    const conversation = this.conversations.get(String(id || '').trim());
    if (!conversation || conversation.ownerKey !== cleanText(ownerKey)) {
      return false;
    }
    const deleted = this.conversations.delete(String(id || '').trim());
    if (deleted) {
      this._write();
    }
    return deleted;
  }

  stats() {
    this._removeExpired();
    let active = 0;
    for (const conversation of this.conversations.values()) {
      if (conversation.activeRequest) {
        active += 1;
      }
    }
    return {
      storedConversations: this.conversations.size,
      activeConversations: active,
      ttlSeconds: Math.floor(this.ttlMs / 1000),
      maxTurns: this.maxTurns,
      maxCount: this.maxCount,
    };
  }

  publicState(conversation) {
    return {
      conversationId: conversation.id,
      title: conversation.title || conversationTitle(conversation.turns[0]?.question),
      createdAt: new Date(conversation.createdAt).toISOString(),
      updatedAt: new Date(conversation.updatedAt).toISOString(),
      expiresAt: new Date(conversation.expiresAt).toISOString(),
      turnCount: conversation.turns.length,
    };
  }

  publicSummary(conversation) {
    return this.publicState(conversation);
  }

  _removeExpired() {
    const now = this.now();
    let changed = false;
    for (const [id, conversation] of this.conversations) {
      if (conversation.expiresAt <= now && !conversation.activeRequest) {
        this.conversations.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this._write();
    }
  }

  _trimToLimit() {
    while (this.conversations.size > this.maxCount) {
      const oldest = [...this.conversations.values()]
        .filter((conversation) => !conversation.activeRequest)
        .sort((left, right) => left.updatedAt - right.updatedAt)[0];
      if (!oldest) {
        break;
      }
      this.conversations.delete(oldest.id);
    }
  }

  _write() {
    if (!this.persist) {
      return;
    }
    const payload = {
      version: 1,
      updatedAt: new Date(this.now()).toISOString(),
      conversations: [...this.conversations.values()].map((conversation) => ({
        id: conversation.id,
        ownerKey: conversation.ownerKey,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        expiresAt: conversation.expiresAt,
        title: conversation.title,
        turns: conversation.turns,
        upstream: conversation.upstream,
      })),
    };
    const directory = path.dirname(this.storePath);
    const tempPath = path.join(
      directory,
      `.${path.basename(this.storePath)}.${process.pid}.${Date.now()}.tmp`,
    );
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.renameSync(tempPath, this.storePath);
    try {
      fs.chmodSync(this.storePath, 0o600);
    } catch {
      // Best effort only; write mode covers normal creation.
    }
  }
}

function normalizeConversation(value) {
  const id = cleanText(value?.id);
  const createdAt = Number(value?.createdAt);
  const updatedAt = Number(value?.updatedAt);
  const expiresAt = Number(value?.expiresAt);
  if (!id || !Number.isFinite(createdAt) || !Number.isFinite(updatedAt) || !Number.isFinite(expiresAt)) {
    return null;
  }
  return {
    id,
    ownerKey: cleanText(value?.ownerKey),
    createdAt,
    updatedAt,
    expiresAt,
    title: conversationTitle(value?.title),
    turns: Array.isArray(value.turns)
      ? value.turns
          .map((turn) => ({
            question: truncate(turn?.question, 2000),
            answer: truncate(turn?.answer, 8000),
            createdAt: Number(turn?.createdAt) || updatedAt,
            sources: normalizePublicSources(turn?.sources),
            searchSummary: normalizeSearchSummary(turn?.searchSummary),
          }))
          .filter((turn) => turn.question && turn.answer)
      : [],
    upstream: {
      accountId: cleanText(value.upstream?.accountId),
      sessionId: cleanText(value.upstream?.sessionId),
    },
    activeRequest: false,
  };
}

function normalizeAppendTurnArguments(metadataOrOwnerKey, ownerKey) {
  if (typeof metadataOrOwnerKey === 'string') {
    return { metadata: {}, resolvedOwnerKey: metadataOrOwnerKey };
  }
  return {
    metadata:
      metadataOrOwnerKey && typeof metadataOrOwnerKey === 'object' && !Array.isArray(metadataOrOwnerKey)
        ? metadataOrOwnerKey
        : {},
    resolvedOwnerKey: ownerKey,
  };
}

function normalizePublicSources(value, answer = '') {
  if (!Array.isArray(value)) {
    return [];
  }

  const citedIndexes = new Set(
    [...String(answer || '').matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1])),
  );
  const orderedSources = citedIndexes.size
    ? [
        ...value.filter((source) => citedIndexes.has(Number(source?.index))),
        ...value.filter((source) => !citedIndexes.has(Number(source?.index))),
      ]
    : value;
  const sources = [];
  const seen = new Set();
  for (const rawSource of orderedSources) {
    if (!rawSource || typeof rawSource !== 'object' || Array.isArray(rawSource)) {
      continue;
    }
    const title = truncate(rawSource.title, MAX_SOURCE_TITLE_LENGTH);
    const snippet = truncate(rawSource.snippet, MAX_SOURCE_SNIPPET_LENGTH);
    if (!title && !snippet) {
      continue;
    }
    const key = `${title}\n${snippet}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const rawIndex = Number(rawSource.index);
    sources.push({
      index: Number.isInteger(rawIndex) && rawIndex > 0 ? rawIndex : sources.length + 1,
      title: title || '知识库资料',
      snippet,
    });
    if (sources.length >= MAX_PERSISTED_SOURCES) {
      break;
    }
  }
  return sources;
}

function normalizeSearchSummary(value) {
  return truncate(value, MAX_SEARCH_SUMMARY_LENGTH);
}

function conversationTitle(value) {
  const text = cleanText(value).replace(/\s+/g, ' ');
  return text.length > 72 ? `${text.slice(0, 72)}...` : text;
}

function boundedLimit(value, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, DEFAULT_CONVERSATION_LIST_LIMIT);
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback;
}

function truncate(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function cleanText(value) {
  return String(value || '').trim();
}

module.exports = {
  ConversationBusyError,
  ConversationNotFoundError,
  ConversationStore,
  DEFAULT_CONVERSATION_LIST_LIMIT,
  DEFAULT_CONVERSATION_MAX_COUNT,
  DEFAULT_CONVERSATION_MAX_TURNS,
  DEFAULT_CONVERSATION_TTL_MS,
  MAX_PERSISTED_SOURCES,
  normalizePublicSources,
};
