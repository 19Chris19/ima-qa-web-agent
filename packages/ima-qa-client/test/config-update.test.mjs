import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, atomic } from '../src/config.mjs';
import { update } from '../src/update.mjs';

test('profile validation rejects insecure remote endpoints and isolates knowledge scopes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ima-config-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'client.json');
  const p = { baseUrl: 'http://remote.example', applicationId: 'a', clientId: 'c', knowledgeScopeRef: 'a'.repeat(64), apiToken: 'one', internalServiceToken: 'two' };
  await atomic(file, { profiles: { default: p } });
  await assert.rejects(loadConfig(file), { code: 'https_required' });
  p.baseUrl = 'http://127.0.0.1'; await atomic(file, { profiles: { default: p } });
  const first = await loadConfig(file);
  p.knowledgeScopeRef = 'b'.repeat(64); await atomic(file, { profiles: { default: p } });
  assert.notEqual(first.stateDir, (await loadConfig(file)).stateDir);
  p.apiTokenEnv = 'IMA_SYNTHETIC_MISSING_CREDENTIAL'; await atomic(file, { profiles: { default: p } });
  await assert.rejects(loadConfig(file), { code: 'credential_missing' });
});
test('updater refuses floating tags and mismatched checksums before package installation', async t => {
  await assert.rejects(update({ version: 'latest' }), { code: 'fixed_release_tag_required' });
  const dir = await mkdtemp(join(tmpdir(), 'ima-update-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await atomic(join(dir, 'installation.json'), {});
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  globalThis.fetch = async url => new Response(url.endsWith('SHA256SUMS') ? '0'.repeat(64) + '  ima-qa-client.tgz\n' : 'bad archive');
  await assert.rejects(update({ version: 'agent-v0.1.0', installDir: dir }), { code: 'release_checksum_mismatch' });
});
