import { createHash } from 'node:crypto';

// Process-local deduplication only. Production adapters must persist receipt state.
export class BotAdapter {
  constructor({ ask, capacity }) {
    this.ask = ask;
    this.capacity = capacity;
    this.receipts = new Map();
    this.conversations = new Map();
    this.users = new Map();
    this.active = 0;
  }

  receive({ user, messageId, question, signal }) {
    if (![user, messageId, question].every(value => typeof value === 'string' && value.trim())) throw new Error('invalid_message');
    const owner = createHash('sha256').update(user).digest('hex');
    const key = `${owner}:${messageId}`;
    const digest = createHash('sha256').update(question).digest('hex');
    const previous = this.receipts.get(key);
    if (previous) {
      if (previous.digest !== digest) throw new Error('idempotency_conflict');
      return previous.promise;
    }
    if (this.receipts.size >= 1000) throw new Error('demo_receipt_limit');
    const preceding = this.users.get(owner) || Promise.resolve();
    const promise = preceding.catch(() => {}).then(async () => {
      while (true) {
        signal?.throwIfAborted();
        const capacity = await this.capacity();
        const limit = Math.max(0, Math.min(30, Number(capacity.maxConcurrent) || 0));
        if (this.active < limit) { this.active++; break; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      try {
        const result = await this.ask({ owner, messageId, question, conversationId: this.conversations.get(owner), signal });
        if (!result.success || !result.answer || !result.conversationId) throw new Error('incomplete_response');
        this.conversations.set(owner, result.conversationId);
        return result;
      } finally { this.active--; }
    });
    this.receipts.set(key, { digest, promise });
    this.users.set(owner, promise);
    return promise;
  }
}
