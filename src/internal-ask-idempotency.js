const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const lockfile = require('proper-lockfile');

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 10000;
const localLockTails = new Map();
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');

async function acquireLocalLock(file) {
  const previous = localLockTails.get(file) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  const tail = previous.then(() => current);
  localLockTails.set(file, tail);
  await previous;
  return () => {
    release();
    void tail.then(() => {
      if (localLockTails.get(file) === tail) localLockTails.delete(file);
    });
  };
}

class InternalAskIdempotency {
  constructor({ storePath, ttlMs = DEFAULT_TTL_MS, now = Date.now }) {
    this.storePath = path.resolve(storePath);
    this.ttlMs = ttlMs;
    this.now = now;
    this.instanceId = crypto.randomUUID();
  }

  key(owner, suppliedKey) {
    return hash(`${hash(owner)}\0${suppliedKey}`);
  }

  fingerprint(question, conversationId) {
    return hash(JSON.stringify({ question: String(question).trim(), conversationId: String(conversationId || '') }));
  }

  async claim(owner, suppliedKey, requestHash) {
    const key = this.key(owner, suppliedKey);
    const claimed = await this.update(entries => {
      const existing = entries[key];
      if (existing && existing.expiresAt > this.now()) {
        if (existing.requestHash !== requestHash) throw Object.assign(new Error('idempotency_conflict'), { code: 'idempotency_conflict', statusCode: 409 });
        if (existing.state === 'processing' && existing.instanceId !== this.instanceId) {
          existing.state = 'unknown';
          existing.updatedAt = this.now();
        }
        return { entry: existing, isNew: false };
      }
      const next = { key, ownerHash: hash(owner), requestHash, state: 'processing', instanceId: this.instanceId, createdAt: this.now(), updatedAt: this.now(), expiresAt: this.now() + this.ttlMs };
      entries[key] = next;
      return { entry: next, isNew: true };
    });
    return { ...claimed.entry, key, isNew: claimed.isNew };
  }

  async complete(key, owner, { conversationId, question, answer }) {
    return this.update(entries => {
      const entry = entries[key];
      if (!entry || entry.ownerHash !== hash(owner) || entry.instanceId !== this.instanceId || entry.state === 'complete') {
        throw Object.assign(new Error('idempotency_conflict'), { code: 'idempotency_conflict', statusCode: 409 });
      }
      Object.assign(entry, { state: 'complete', conversationId, questionHash: hash(question), answerHash: hash(answer), completedAt: this.now(), updatedAt: this.now() });
      return entry;
    });
  }

  async markUnknown(key, owner) {
    return this.update(entries => {
      const entry = entries[key];
      if (!entry || entry.ownerHash !== hash(owner) || entry.instanceId !== this.instanceId || entry.state === 'complete' || entry.state === 'unknown') return entry;
      entry.state = 'unknown';
      entry.updatedAt = this.now();
      return entry;
    });
  }

  async update(mutator) {
    await fs.mkdir(path.dirname(this.storePath), { recursive: true, mode: 0o700 });
    try {
      const handle = await fs.open(this.storePath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ generation: 0, entries: {} }));
      await handle.close();
    } catch (error) {
      if (error.code !== 'EEXIST') throw this.storageError(error);
    }

    let release;
    let releaseLocal;
    try {
      releaseLocal = await acquireLocalLock(this.storePath);
      release = await lockfile.lock(this.storePath, { stale: 10000, update: 2000, retries: { retries: 100, minTimeout: 50, maxTimeout: 100 } });
      const store = JSON.parse(await fs.readFile(this.storePath, 'utf8'));
      const entries = store.entries && typeof store.entries === 'object' ? { ...store.entries } : {};
      const before = JSON.stringify(entries);
      for (const [key, entry] of Object.entries(entries)) if (!entry || entry.expiresAt <= this.now()) delete entries[key];
      const result = mutator(entries);
      if (Object.keys(entries).length > MAX_ENTRIES) throw Object.assign(new Error('idempotency_store_full'), { code: 'idempotency_store_full', statusCode: 503 });
      if (JSON.stringify(entries) === before) return result;

      const next = { ...store, generation: Number(store.generation || 0) + 1, entries };
      const temp = `${this.storePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.writeFile(temp, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
        await fs.rename(temp, this.storePath);
        await fs.chmod(this.storePath, 0o600);
      } catch (error) {
        await fs.rm(temp, { force: true }).catch(() => {});
        throw error;
      }
      return result;
    } catch (error) {
      if (['idempotency_conflict', 'idempotency_store_full', 'account_store_locked'].includes(error.code)) throw error;
      if (error.code === 'ELOCKED') throw Object.assign(new Error('幂等存储正在更新，请稍后重试'), { code: 'account_store_locked', statusCode: 409 });
      throw this.storageError(error);
    } finally {
      await release?.().catch(() => {});
      releaseLocal?.();
    }
  }

  storageError(cause) {
    const causeCode = /^[A-Z0-9_]{2,32}$/u.test(String(cause?.code || '')) ? cause.code : 'unknown';
    return Object.assign(new Error('内部幂等存储不可用'), { code: 'idempotency_store_unavailable', statusCode: 503, storageCauseCode: causeCode });
  }
}

module.exports = { InternalAskIdempotency, DEFAULT_TTL_MS };
