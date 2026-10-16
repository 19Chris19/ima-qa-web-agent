'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
// The client PR is independently reviewable on #32. Joint CI activates this
// test after the companion backend lands, or with an explicit development path.
const backend = path.resolve(process.env.IMA_SOURCE_EVIDENCE_PROVIDER_CHECKOUT || path.join(__dirname, '..'));
const available = fs.existsSync(path.join(backend, 'src/source-reader.js'));
test('SDK STDIO -> actual paired Provider routes -> synthetic original -> immutable evidence export and restart', { skip: !available }, async t => {
  const { Client } = await import('../packages/ima-qa-client/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
  const { StdioClientTransport } = await import('../packages/ima-qa-client/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');
  const { fixture, scope } = require(path.join(backend, 'scripts/test-fixtures/source-evidence-app.cjs'));
  const { SourceReader } = require(path.join(backend, 'src/source-reader.js'));
  const reader = new SourceReader({ schemaVersion: 1, readers: [{ id: 'reader', applications: ['agent-a'], scopeRef: scope,
    clientId: 'synthetic-openapi-client', apiKey: 'synthetic-openapi-key', idNamespace: 'ima_web_media', identity: {
      mode: 'explicit_bindings', bindings: { 'synthetic-media-a': 'synthetic-api-id' } } }] },
    { workerPath: path.join(backend, 'scripts/test-fixtures/source-reader-worker.cjs') });
  const f = await fixture(t, { app: { sourceReader: reader } }), taskId = await f.submit();
  const configFile = path.join(f.dir, 'client.json');
  fs.writeFileSync(configFile, JSON.stringify({ profiles: { default: { baseUrl: f.base, applicationId: 'agent-a', clientId: 'synthetic-visitor',
    knowledgeScopeRef: scope, apiToken: 'synthetic-a', internalServiceToken: 'synthetic-a-service' } } }), { mode: 0o600 });
  const connect = async () => {
    const client = new Client({ name: 'source-evidence-integration', version: '1' });
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [path.join(__dirname, '../packages/ima-qa-client/bin/ima-qa.mjs'), 'mcp', '--config', configFile], stderr: 'pipe' }));
    return client;
  };
  let client = await connect();
  try {
    const tools = await client.listTools(); assert.equal(tools.tools.length, 8);
    const status = (await client.callTool({ name: 'ima_qa_status', arguments: {} })).structuredContent;
    assert.equal(status.identityPairing, 'verified'); assert.equal(status.sourceEvidence.readConfigured, true);
    const full = (await client.callTool({ name: 'ima_qa_get_task', arguments: { taskId, view: 'full' } })).structuredContent;
    assert.deepEqual(full.citationMap['index:42'].displayNumbers, ['7']);
    assert.equal(full.knowledgeEvidence.materials[full.citationMap['index:42'].materialRefs[0]].materialId, 'synthetic-media-a');
    const original = (await client.callTool({ name: 'ima_qa_export', arguments: { taskId, format: 'json' } })).structuredContent;
    const originalBytes = fs.readFileSync(original.output);
    const info = (await client.callTool({ name: 'ima_qa_get_source', arguments: { taskId, citationKey: 'index:42' } })).structuredContent;
    assert.equal(info.mappingStatus, 'mapped');
    const args = { taskId, citationKey: 'index:42', sourceRef: info.materials[0].sourceRef };
    let cursor, pages = 0, readId;
    do {
      const result = await client.callTool({ name: 'ima_qa_read_source', arguments: { ...args, ...(cursor ? { cursor } : {}) } });
      assert.notEqual(result.isError, true); const value = result.structuredContent;
      if (readId) assert.equal(value.readId, readId); else readId = value.readId;
      cursor = value.nextCursor; pages++; assert.match(value.content, /Synthetic original material/);
    } while (cursor);
    assert.ok(pages > 1); assert.equal(reader.metrics.reads, 1);
    const exported = (await client.callTool({ name: 'ima_qa_export', arguments: { taskId, format: 'json', includeReadEvidence: true } })).structuredContent;
    const evidence = JSON.parse(fs.readFileSync(exported.output));
    assert.equal(evidence.readEvidence[0].verifiedDigest, true); assert.equal(evidence.readEvidence[0].complete, true);
    assert.doesNotMatch(JSON.stringify(evidence), /synthetic-openapi-key|synthetic-api-id/);
    assert.notEqual(original.output, exported.output); assert.deepEqual(fs.readFileSync(original.output), originalBytes);
    const publicView = await (await f.request('/internal/provider-a/tasks/' + taskId + '?presentation=chat_v1')).text();
    assert.doesNotMatch(publicView, /synthetic-media|knowledgeEvidence|readEvidence/);
    await client.close(); client = await connect();
    const restored = (await client.callTool({ name: 'ima_qa_get_task', arguments: { taskId, view: 'full' } })).structuredContent;
    assert.deepEqual(restored.knowledgeEvidence, full.knowledgeEvidence); assert.equal(f.calls(), 1);
  } finally { await client.close(); }
});
