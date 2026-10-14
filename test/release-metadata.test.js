const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { releaseMetadata } = require('../src/release-metadata');
const { createApp } = require('../src/app');

test('release metadata reports packaged version and only a valid source revision', () => {
  const revision = 'a'.repeat(40);
  const valid = releaseMetadata({ IMA_QA_RELEASE_REVISION: revision, IMA_QA_ADMIN_TOKEN: 'synthetic-private' });
  assert.equal(valid.version, `v${require('../package.json').version}`);
  assert.equal(valid.revision, revision); assert.equal(valid.taskRecordFormat, 'jsonl_v2');
  assert.doesNotMatch(JSON.stringify(valid), /synthetic-private/);
  for (const input of ['local-dev', 'v0.3.0-rc.1-old', 'https://private.example/secret', 'x'.repeat(100)]) {
    assert.equal(releaseMetadata({ IMA_QA_RELEASE_REVISION: input }).revision, null);
  }
});

test('health reports release provenance and mapped capability identity follows authenticated application only', async t => {
  const release = releaseMetadata({ IMA_QA_RELEASE_REVISION: 'b'.repeat(40) });
  const app = createApp({ config: { release, qaProvider: 'ima-web-agent', webAgent: {}, mimo: {},
    security: { applications: [{ id: 'synthetic-app', apiTokens: ['synthetic-api'], internalServiceTokens: ['synthetic-internal'] }] },
    limits: {}, concurrency: {}, rateLimit: {} } });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual((await (await fetch(base + '/healthz')).json()).release, release);
  const capabilities = await (await fetch(base + '/api/capabilities', { headers: { Authorization: 'Bearer synthetic-api', 'X-IMA-Application-Id': 'forged' } })).json();
  assert.equal(capabilities.applicationId, 'synthetic-app');
  const capacity = await (await fetch(base + '/internal/provider-a/capacity', { headers: { Authorization: 'Bearer synthetic-internal' } })).json();
  assert.equal(capacity.applicationId, 'synthetic-app');
  assert.equal((await fetch(base + '/api/capabilities', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
});
