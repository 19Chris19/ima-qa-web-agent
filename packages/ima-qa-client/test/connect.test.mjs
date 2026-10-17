import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, chmod, lstat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectLocal } from '../src/connect.mjs';
import { atomic, digest, loadConfig } from '../src/config.mjs';

test('local deployment bridge copies only paired client credentials, keeps identity stable and protects existing profiles', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ima-connect-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const providerEnv = join(dir, 'provider.env'), config = join(dir, 'client.json');
  const env = { IMA_WEB_AGENT_SHARED_KNOWLEDGE_BASE_ID: 'synthetic-scope', IMA_QA_API_TOKEN: 'ordinary', IMA_QA_INTERNAL_SERVICE_TOKEN: 'internal', IMA_QA_ADMIN_TOKEN: 'admin-secret', IMA_WEB_AGENT_HEADERS_JSON: 'cookie-secret', IMA_QA_ACCOUNT_STORE_KEY: 'encryption-secret' };
  await writeFile(providerEnv, Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n'), { mode: 0o600 });
  let checks = 0;
  class Client { constructor(p) { assert.equal(p.applicationId, 'legacy'); this.p = p; }
    async status() { checks++; return { identityPairing: 'legacy_shared', ready: false }; } }
  const options = { providerEnv, config, baseUrl: 'http://127.0.0.1:3117', applicationId: 'legacy' };
  await assert.rejects(connectLocal({ ...options, applicationId: undefined }), { code: 'named_application_required' });
  assert.equal((await connectLocal(options, { Client })).configured, true);
  const before = await readFile(config, 'utf8');
  assert.ok(!before.includes('admin-secret')); assert.ok(!before.includes('cookie-secret')); assert.ok(!before.includes('encryption-secret'));
  const p = await loadConfig(config); assert.equal(p.knowledgeScopeRef, digest('synthetic-scope'));
  assert.equal((await lstat(config)).mode & 0o777, 0o600);
  assert.equal((await connectLocal(options, { Client })).reused, true);
  assert.equal(await readFile(config, 'utf8'), before); assert.equal(checks, 2);
  await assert.rejects(connectLocal({ ...options, baseUrl: 'http://remote.example' }, { Client }), { code: 'loopback_required' });
  await writeFile(providerEnv, 'IMA_WEB_AGENT_SHARED_KNOWLEDGE_BASE_ID=changed\nIMA_QA_API_TOKEN=ordinary\nIMA_QA_INTERNAL_SERVICE_TOKEN=internal');
  await assert.rejects(connectLocal(options, { Client }), { code: 'existing_profile_protected' });
  await chmod(providerEnv, 0o644);
  if (process.platform !== 'win32') await assert.rejects(connectLocal(options, { Client }), { code: 'private_provider_file_required' });
  await chmod(config, 0o644);
  if (process.platform !== 'win32') await assert.rejects(loadConfig(config), { code: 'private_client_config_required' });
});

test('named applications require a selection, never mix token roles or silently fall back to legacy', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ima-connect-app-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const providerEnv = join(dir, 'provider.json'), config = join(dir, 'client.json');
  const env = { IMA_WEB_AGENT_SHARED_KNOWLEDGE_BASE_ID: 'scope', IMA_QA_APPLICATIONS_JSON: JSON.stringify([
    { id: 'one', apiTokens: ['one-api'], internalServiceTokens: ['one-service'] }, { id: 'two', apiTokens: ['two-api'], internalServiceTokens: ['two-service'] }]) };
  await atomic(providerEnv, env);
  const options = { providerEnv, config, baseUrl: 'http://localhost:3117' };
  await assert.rejects(connectLocal(options), { code: 'application_selection_required' });
  await assert.rejects(connectLocal({ ...options, applicationId: 'absent' }), { code: 'application_not_found' });
  class Client { constructor(p) { assert.equal(p.apiToken, 'two-api'); assert.equal(p.internalServiceToken, 'two-service'); }
    async status() { return { ready: true, identityPairing: 'verified' }; } }
  await connectLocal({ ...options, applicationId: 'two' }, { Client });
  const link = join(dir, 'symlink.json'); await symlink(config, link);
  await assert.rejects(loadConfig(link), { code: 'private_client_config_required' });
});
