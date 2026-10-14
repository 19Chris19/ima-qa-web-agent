'use strict';
const { parentPort, workerData, isMainThread } = require('node:worker_threads');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { fetchCover, LIMITS, imageType, failure } = require('./source-preview-network');
const hash = value => createHash('sha256').update(value).digest('hex');
const BUDGET = Object.freeze({ bytes: 128 * 1024 * 1024, entries: 2000, ttl: 7 * 86400000, failureTtl: 3600000 });
class PreviewCache {
  constructor(directory, limits = BUDGET) { this.directory = directory; this.limits = limits; this.entries = new Map(); this.initializing = null; }
  async init() {
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const stat = await fs.lstat(this.directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('unsafe_cache');
      await fs.chmod(this.directory, 0o700);
      try {
        const file = await fs.open(path.join(this.directory, 'index.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
        let input;
        try { if ((await file.stat()).size > 1024 * 1024) throw failure('invalid_cache'); input = JSON.parse(await file.readFile('utf8')); } finally { await file.close(); }
        if (!Array.isArray(input) || input.length > this.limits.entries) throw failure('invalid_cache');
        for (const row of input) if (/^[a-f0-9]{64}$/u.test(row.key) && Number.isFinite(row.expires)
          && Number.isFinite(row.used) && Number.isInteger(row.bytes) && row.bytes >= 0 && row.bytes <= LIMITS.image
          && (row.bytes === 0 || (['image/png', 'image/jpeg', 'image/webp'].includes(row.type) && /^[a-f0-9]{64}$/u.test(row.digest)))) this.entries.set(row.key, row);
      } catch (error) { if (error.code !== 'ENOENT') this.entries.clear(); }
      // A failed/crashed write must not leave unaccounted images accumulating.
      for (const name of await fs.readdir(this.directory)) {
        if (/^[a-f0-9]{64}\.img$/u.test(name) && !this.entries.has(name.slice(0, -4)) || /^index\.tmp-/u.test(name)) await fs.unlink(path.join(this.directory, name)).catch(() => {});
      }
      await this.prune();
    })();
    return this.initializing;
  }
  async lookup(key, now = Date.now()) {
    await this.init();
    const row = this.entries.get(key);
    if (!row || row.expires <= now) return null;
    row.used = now;
    return { ...row, status: row.bytes ? 'ready' : 'text_only' };
  }
  async image(key, now = Date.now()) {
    const row = await this.lookup(key, now);
    if (!row?.bytes) return null;
    let file;
    try {
      file = await fs.open(path.join(this.directory, `${key}.img`), constants.O_RDONLY | constants.O_NOFOLLOW);
      if (!(await file.stat()).isFile() || (await file.stat()).size !== row.bytes) throw failure('invalid_cache');
      const bytes = await file.readFile();
      if (hash(bytes) !== row.digest || imageType(bytes) !== row.type) throw failure('invalid_cache');
      return { bytes, type: row.type };
    } catch { return null; } finally { await file?.close(); }
  }
  async put(key, image, now = Date.now()) {
    await this.init();
    // A timed-out job can still be finishing filesystem IO. Shed overlapping
    // writes rather than queue them or race atomic index replacements.
    if (this.writing) return { status: 'text_only' };
    this.writing = true;
    try {
      const bytes = image?.bytes?.length || 0;
      if (bytes > LIMITS.image || (bytes && imageType(image.bytes) !== image.type)) throw failure('invalid_image');
      // Remove the old file before replacement; disk usage never exceeds the cap.
      const old = this.entries.get(key); this.entries.delete(key);
      if (old?.bytes) await fs.unlink(path.join(this.directory, `${key}.img`)).catch(() => {});
      await this.prune(bytes, 1, now);
      if (bytes) await fs.writeFile(path.join(this.directory, `${key}.img`), image.bytes, { mode: 0o600, flag: 'wx' });
      const row = { key, bytes, used: now, expires: now + (bytes ? this.limits.ttl : this.limits.failureTtl),
        ...(bytes ? { type: image.type, digest: hash(image.bytes) } : {}) };
      this.entries.set(key, row);
      await this.save(); return { ...row, status: bytes ? 'ready' : 'text_only' };
    } finally { this.writing = false; }
  }
  async prune(extraBytes = 0, extraEntries = 0, now = Date.now()) {
    let bytes = [...this.entries.values()].reduce((sum, row) => sum + row.bytes + 256, 0);
    const reserve = Math.min(1024 * 1024, Math.floor(this.limits.bytes / 8)); // Atomic index replacement also uses disk.
    for (const row of [...this.entries.values()].sort((a, b) => a.used - b.used)) {
      if (row.expires > now && bytes + extraBytes + 256 + reserve <= this.limits.bytes && this.entries.size + extraEntries <= this.limits.entries) continue;
      this.entries.delete(row.key); bytes -= row.bytes + 256;
      if (row.bytes) await fs.unlink(path.join(this.directory, `${row.key}.img`)).catch(() => {});
    }
  }
  async save() {
    const name = path.join(this.directory, `index.tmp-${process.pid}`);
    await fs.writeFile(name, JSON.stringify([...this.entries.values()]), { mode: 0o600, flag: 'w' });
    await fs.rename(name, path.join(this.directory, 'index.json'));
  }
}
function startWorker({ port = parentPort, directory = workerData.directory, fetchImpl = fetchCover } = {}) {
  const cache = new PreviewCache(directory), permits = new Map(), jobs = new Map(); let nextPermit = 0;
  port.on('message', async message => {
    if (message.op === 'permit-result') { permits.get(message.permitId)?.(message.allowed); permits.delete(message.permitId); return; }
    if (message.op === 'cancel') { jobs.get(message.id)?.abort(failure(message.reason === 'timeout' ? 'timeout' : 'cancelled')); return; }
    const { id, op, key, url } = message;
    try {
      if (op === 'lookup') { port.postMessage({ id, result: await cache.lookup(key) }); return; }
      if (op === 'image') { port.postMessage({ id, result: await cache.image(key) }); return; }
      if (op !== 'fetch') throw failure('invalid_operation');
      const controller = new AbortController(); jobs.set(id, controller);
      const timer = setTimeout(() => controller.abort(failure('timeout')), LIMITS.timeout);
      const permit = () => new Promise(resolve => {
        const permitId = ++nextPermit;
        const abort = () => { permits.delete(permitId); resolve(false); };
        controller.signal.addEventListener('abort', abort, { once: true });
        permits.set(permitId, allowed => { controller.signal.removeEventListener('abort', abort); resolve(allowed); });
        port.postMessage({ op: 'permit', id, permitId });
        if (controller.signal.aborted) abort();
      });
      let result;
      try { result = await cache.put(key, await fetchImpl(url, { signal: controller.signal, permit })); }
      catch (error) {
        result = (['budget', 'cancelled', 'AbortError'].includes(error.code) || controller.signal.aborted) && controller.signal.reason?.code !== 'timeout'
          ? { status: 'text_only' } : await cache.put(key, null);
      } finally { clearTimeout(timer); jobs.delete(id); }
      port.postMessage({ id, result });
    } catch { port.postMessage({ id, error: 'preview_unavailable' }); }
  });
}
if (!isMainThread && require.main === module) startWorker();
module.exports = { PreviewCache, BUDGET, startWorker };
