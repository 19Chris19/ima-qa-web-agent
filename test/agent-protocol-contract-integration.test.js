const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const crypto = require('node:crypto');
const provider = path.resolve(process.env.IMA_PROTOCOL_PROVIDER_CHECKOUT || path.join(__dirname, '..'));
const available = fs.existsSync(path.join(provider, 'src/source-evidence-contract.js'));

test('SDK STDIO -> named client -> real Provider routes -> mocked IMA wire preserves evidence, ownership and replay',
  { skip: available ? false : 'Paired Provider protocol PR required; no joint acceptance claimed.' }, async t => {
  const { createApp } = require(path.join(provider, 'src/app'));
  const { ConversationStore } = require(path.join(provider, 'src/conversation-store'));
  const { IMAWebAgentClient } = require(path.join(provider, 'src/ima-web-agent-client'));
  const { guided } = require(path.join(provider, 'src/guided-deployment'));
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(provider, 'src/source-evidence-contract.js'))).digest('hex'),
    crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '../packages/ima-qa-client/src/source-evidence-contract.cjs'))).digest('hex'));
  const { fixture } = require(path.join(provider, 'test/helpers/share-metadata'));
  const { ImaClient } = await import('../packages/ima-qa-client/src/client.mjs');
  const { connectLocal } = await import('../packages/ima-qa-client/src/connect.mjs');
  const { Client } = await import('../packages/ima-qa-client/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
  const { StdioClientTransport } = await import('../packages/ima-qa-client/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ima-protocol-joint-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const install = { mode: 'server', image: 'synthetic/provider:fixture', shareUrl: 'https://ima.qq.com/wiki/?shareId=' + 'a'.repeat(64) };
  await guided(dir, 'install', install, () => {}, { run: async () => {}, portAvailable: async () => {},
    capture: async (bin, args) => args[0] === 'image' ? JSON.stringify(['synthetic/provider@sha256:' + 'a'.repeat(64)]) : '',
    fetch: async url => url.includes('/bootstrap') ? Response.json({ provider: 'ima-web-agent', sharedKnowledgeBaseId: '123456789',
      enrollment: { authorizationProtocol: 'shared_library_membership_v1' } }) : new Response(fixture()) });
  const envFile = path.join(dir, '.onboarding/provider.env'), env = require('dotenv').parse(fs.readFileSync(envFile));
  const apps = JSON.parse(env.IMA_QA_APPLICATIONS_JSON);
  const upstream = [];
  const fakeFetch = async (url, options) => {
    assert.equal(new URL(url).origin, 'https://ima.qq.com');
    const body = JSON.parse(options.body); upstream.push({ path: new URL(url).pathname, body });
    if (url.endsWith('/init_session')) return Response.json({ session_id: 'SCRUBBED_SESSION' });
    assert.ok(url.endsWith('/assistant/qa'), 'No other upstream operation is permitted by this fixture');
    const web = body.question.includes('本轮请同时检索');
    const packet = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    return new Response((web ? packet('CONTEXT_REFERENCES', { '42': [{ sourceType: 0, title: 'Scrubbed webpage',
      jumpUrl: 'https://example.org/fixture', content: 'Scrubbed excerpt' }] }) : '')
      + packet('MESSAGE', { Text: web ? 'Scrubbed answer[7](@context-ref?id=42)' : 'Scrubbed followup' })
      + packet('COMPLETED', { Code: 0 }));
  };
  const native = new IMAWebAgentClient({ knowledgeBaseId: '123456789', modelId: 'SCRUBBED_MODEL', modelType: 3,
    taskFetchImpl: fakeFetch, headers: { 'x-ima-cookie': 'IMA-UID=synthetic; IMA-TOKEN=synthetic; WEB-VERSION=5.11.2', 'x-ima-bkn': '123' } }, fakeFetch);
  const app = createApp({ config: { qaProvider: 'ima-web-agent', mimo: {}, webAgent: { sharedKnowledgeBaseId: '123456789' },
    conversations: { storePath: path.join(dir, 'history.json') }, security: { applications: apps,
      apiToken: env.IMA_QA_API_TOKEN, internalServiceToken: env.IMA_QA_INTERNAL_SERVICE_TOKEN },
    concurrency: { maxConcurrentAsk: 1, queueLimit: 10 }, limits: { maxQuestionLength: 2000 }, rateLimit: { windowMs: 0, max: 0 } },
    conversationStore: new ConversationStore({ storePath: path.join(dir, 'history.json') }),
    webReadiness: { mode: 'knowledge_agent', snapshot: () => ({ mode: 'knowledge_agent', knowledgeAgentCapacity: 1, capacity: 1, schedulable: 1 }) },
    imaWebAgentClient: { async *streamAsk(args) { yield* native.streamAsk({ ...args, allowAuthRefresh: false,
      onSession: sid => args.onSession?.(sid, 'synthetic-account', 'classic_knowledge') }); } },
  });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { app.locals.durableQATasks.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`, configFile = path.join(dir, 'agent.json');
  const connected = await connectLocal({ providerEnv: envFile, baseUrl, config: configFile });
  assert.equal(connected.provider.isolationVerified, true); assert.equal(upstream.length, 0);
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.resolve(__dirname, '../packages/ima-qa-client/bin/ima-qa.mjs'), 'mcp', '--config', configFile], stderr: 'pipe' });
  const sdk = new Client({ name: 'synthetic-acceptance', version: '1' });
  await sdk.connect(transport); t.after(() => sdk.close());
  const toolNames = (await sdk.listTools()).tools.map(x => x.name);
  assert.ok(['ima_qa_status', 'ima_qa_ask', 'ima_qa_get_task', 'ima_qa_get_conversation', 'ima_qa_cancel', 'ima_qa_export']
    .every(name => toolNames.includes(name)));
  assert.equal((await sdk.callTool({ name: 'ima_qa_status', arguments: {} })).structuredContent.isolationVerified, true);
  const first = (await sdk.callTool({ name: 'ima_qa_ask', arguments: { question: 'Scrubbed first question',
    sourceIntent: 'web', requestKey: 'fixture-first', waitSeconds: 2 } })).structuredContent;
  assert.equal(first.status, 'succeeded'); assert.equal(first.webEvidenceStatus, 'verified');
  const full = (await sdk.callTool({ name: 'ima_qa_get_task', arguments: { taskId: first.taskId, view: 'full' } })).structuredContent;
  assert.deepEqual(full.citationMap['context:42'].displayNumbers, ['7']);
  const second = (await sdk.callTool({ name: 'ima_qa_ask', arguments: { question: 'Scrubbed followup',
    conversationId: first.conversationId, requestKey: 'fixture-second', waitSeconds: 2 } })).structuredContent;
  assert.equal(second.status, 'succeeded'); assert.equal(second.webEvidenceStatus, 'not_observed');
  await sdk.callTool({ name: 'ima_qa_ask', arguments: { question: 'Scrubbed first question',
    sourceIntent: 'web', requestKey: 'fixture-first' } });
  assert.equal(upstream.filter(x => x.path.endsWith('/assistant/qa')).length, 2);
  const asks = upstream.filter(x => x.path.endsWith('/assistant/qa'));
  assert.equal(asks[0].body.session_id, asks[1].body.session_id);
  assert.match(asks[0].body.question, /本轮请同时检索/); assert.doesNotMatch(asks[1].body.question, /本轮请同时检索/);
  assert.equal((await sdk.callTool({ name: 'ima_qa_get_conversation', arguments: { conversationId: first.conversationId } })).structuredContent.messages.length, 4);
  const exported = (await sdk.callTool({ name: 'ima_qa_export', arguments: { taskId: first.taskId, format: 'json' } })).structuredContent;
  assert.equal(JSON.parse(fs.readFileSync(exported.output)).webEvidenceStatus, 'verified');
  const wrong = new ImaClient({ baseUrl, applicationId: 'legacy', apiToken: env.IMA_QA_API_TOKEN,
    internalServiceToken: env.IMA_QA_INTERNAL_SERVICE_TOKEN, clientId: connected.provider.clientId,
    stateDir: path.join(dir, 'legacy'), knowledgeScopeRef: crypto.createHash('sha256').update('123456789').digest('hex') });
  await assert.rejects(wrong.task(first.taskId), { code: 'task_not_found' });
  assert.equal(upstream.filter(x => x.path.endsWith('/assistant/qa')).length, 2);
});

test('website BFF and MCP produce the same bound retrieval contract for web on and off',
  { skip: process.env.IMA_PROTOCOL_WEBSITE_CHECKOUT ? false : 'Paired website source not supplied; BFF comparison not claimed.' }, async t => {
  const { createProviderAClient } = await import(require('node:url').pathToFileURL(path.join(process.env.IMA_PROTOCOL_WEBSITE_CHECKOUT, 'provider-a-client.mjs')));
  const { ImaClient } = await import('../packages/ima-qa-client/src/client.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ima-bff-contract-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const web of [false, true]) {
    let bffBody, clientBody;
    const bff = createProviderAClient({ baseUrl: 'http://127.0.0.1:12345', apiToken: 'synthetic-api', serviceToken: 'synthetic-internal',
      knowledgeScopeRef: 'a'.repeat(64), fetchImpl: async (url, options) => { bffBody = JSON.parse(options.body); return Response.json({}); } });
    await bff.request({ route: '/api/tasks', method: 'POST', clientId: 'synthetic', requestId: '00000000-0000-4000-8000-000000000001',
      sourceIntent: web ? 'web' : '', body: JSON.stringify({ question: 'Scrubbed question', conversationId: 'fixture-conversation' }) });
    const client = new ImaClient({ baseUrl: 'http://localhost', applicationId: 'ima-agent', apiToken: 'synthetic-api',
      internalServiceToken: 'synthetic-internal', clientId: 'synthetic', knowledgeScopeRef: 'a'.repeat(64), stateDir: path.join(dir, String(web)) },
    { fetchImpl: async (url, options) => {
      if (url.endsWith('/api/capabilities')) return Response.json({ applicationId: 'ima-agent', features: { durable_qa_tasks_v1: true } });
      if (url.endsWith('/capacity')) return Response.json({ applicationId: 'ima-agent', available: 1,
        policies: { knowledge_agent: { max_concurrent: 1 } }, features: { durable_qa_tasks_v1: true, knowledge_agent_keyed_sse_v1: true, source_intent_web_requested_v1: true } });
      if (options.method === 'POST') { clientBody = JSON.parse(options.body); return Response.json({ task: { id: 'fixture-task' } }); }
      return Response.json({ task: { id: 'fixture-task', status: 'succeeded' }, snapshot: { events: [{ event: 'done', data: { web_source_count: 0 } }] } });
    } });
    await client.ask({ question: 'Scrubbed question', conversationId: 'fixture-conversation', sourceIntent: web ? 'web' : 'knowledge', requestKey: 'fixture' });
    assert.deepEqual(clientBody, bffBody);
  }
});
