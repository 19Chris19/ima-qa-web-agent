'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { getConfig } = require('../src/config');
const { createApp } = require('../src/app');
const { ConversationStore } = require('../src/conversation-store');
const { IMAWebAgentPool } = require('../src/ima-web-agent-pool');
const { AirAccountDirectory } = require('../src/air/account-directory');
const { AirWebReadiness } = require('../src/air/web-readiness');
const { createAirRuntime } = require('../src/air/startup');
const { knowledgeAgentContractDigest } = require('../src/ima-knowledge-agent-contract');
const { answerProfileContractDigest } = require('../src/ima-answer-profile');
const { synchronizeProviderAQueueCapacity } = require('../src/provider-a-capacity');
const { taskTransportFetch } = require('../src/task-transport');

const root = path.resolve(__dirname, '..');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const answer = '  Synthetic native answer\nwith exact whitespace  ';

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'air-startup-acceptance-'));
  fs.chmodSync(directory, 0o700);
  // Cleanup is registered before resources so the enclosing finally closes them first.
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function environment(directory) {
  return { HOME: directory, TMPDIR: directory, PATH: process.env.PATH,
    IMA_QA_PROVIDER: 'ima-web-agent', IMA_QA_AIR_BOT_EXTENSIONS: 'true',
    IMA_WEB_AGENT_ANSWER_PROFILE: 'ima_agent_auto',
    IMA_WEB_AGENT_WEB_MODE: 'knowledge_agent',
    IMA_WEB_AGENT_BROWSER_PATH: path.join(directory, 'no-browser'),
    IMA_WEB_AGENT_RUNTIME_ENV_PATH: path.join(directory, 'absent-synthetic.env'),
    IMA_WEB_AGENT_ACCOUNT_STORE_PATH: path.join(directory, 'accounts.json'),
    IMA_WEB_AGENT_ACCOUNT_STORE_KEY_PATH: path.join(directory, 'account-key'),
    IMA_QA_CONVERSATION_STORE_PATH: path.join(directory, 'conversations.json'),
    IMA_QA_EXERCISE_REPORT_STORE_PATH: path.join(directory, 'exercise-reports.json'),
    IMA_QA_API_TOKEN: 'your-synthetic-api', IMA_QA_INTERNAL_SERVICE_TOKEN: 'your-synthetic-internal',
    IMA_QA_ADMIN_TOKEN: 'your-synthetic-admin', IMA_QA_RATE_LIMIT_MAX: '0' };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  server.closeAllConnections?.();
  if (server.listening) await new Promise(resolve => server.close(resolve));
}

async function until(check, describe, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(20);
  }
  assert.fail(`Timed out: ${describe}`);
}

async function json(base, route, { token = 'your-synthetic-api', status = 200, ...options } = {}) {
  const response = await fetch(base + route, { ...options, signal: AbortSignal.timeout(2000),
    headers: { authorization: `Bearer ${token}`, 'x-ima-client-id': 'synthetic-visitor',
      'content-type': 'application/json', ...options.headers } });
  const body = await response.json();
  assert.equal(response.status, status, `${route}: ${JSON.stringify(body)}`);
  return body;
}

test('Air opt-in alone cannot declare missing runtime dependencies mounted', t => {
  const directory = temporaryDirectory(t);
  const config = getConfig(environment(directory));
  config.conversations = { persist: false };
  const pool = new IMAWebAgentPool({ accounts: [] });
  let app;
  try { app = createApp({ config, imaWebAgentClient: pool }); }
  catch (error) {
    assert.match(error.code || error.message, /(?:air|bot).*mount/iu);
    return;
  }
  assert.notEqual(app.locals.airBotExtensionsMounted, true,
    'A constant flag is not evidence of Air runtime mounting');
});

test('real Air entrypoint mounts health, capacity and admin with no outbound traffic', { timeout: 20000 }, async t => {
  const directory = temporaryDirectory(t);
  // Runtime loader probes this exact path. Refuse to run against any local env file.
  assert.equal(fs.existsSync(path.join(root, '.env')), false, 'Do not read a real app .env');
  const env = environment(directory);
  let port = 0;
  try { getConfig({ ...env, PORT: '0' }); }
  catch (error) {
    assert.match(error.message, /PORT/u);
    const reservation = http.createServer();
    await listen(reservation);
    port = reservation.address().port;
    await close(reservation);
  }
  // Fail the process even if application code catches a network error.
  const guard = `import net from 'node:net'; import fs from 'node:fs';
    import { createRequire } from 'node:module';
    const require = createRequire(${JSON.stringify(path.join(root, 'provider-a-server.js'))});
    const blocked = () => { process.stderr.write('AIR_ACCEPTANCE_OUTBOUND_BLOCKED\\n'); process.exit(86); };
    net.Socket.prototype.connect = blocked; globalThis.fetch = blocked;
    const allowedEnvPaths = ${JSON.stringify([path.join(root, '.env'), env.IMA_WEB_AGENT_RUNTIME_ENV_PATH])};
    require('dotenv').config = options => {
      if (!allowedEnvPaths.includes(options?.path) || fs.existsSync(options.path)) {
        process.stderr.write('AIR_ACCEPTANCE_ENV_FILE_BLOCKED\\n'); process.exit(87);
      }
      return { parsed: undefined };
    };
    const module = require('./src/app'); const original = module.createApp;
    module.createApp = options => {
      const app = original(options);
      process.stdout.write('AIR_ACCEPTANCE_MOUNT ' + JSON.stringify({
        mounted: app.locals.airBotExtensionsMounted === true,
        policies: typeof options.botCompatibility?.snapshot === 'function',
        eligibility: typeof options.imaWebAgentClient?.policyEligibility === 'function',
        readiness: typeof options.webReadiness?.nativeEligible === 'function',
        durable: app.locals.durableQATasks?.available === true,
        queue: typeof app.locals.imaQaAskQueue?.stats === 'function'
      }) + '\\n');
      return app;
    };`;
  const child = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(guard)}`,
    path.join(root, 'provider-a-server.js')], { cwd: directory, env: { ...env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', exited = false;
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }); });
  });
  try {
    await until(() => {
      assert.equal(exited, false, `Air startup exited before listen:\n${output}`);
      return /Main page: http:\/\/localhost:\d+/u.test(output);
    }, 'actual entrypoint listening');
    assert.doesNotMatch(output, /AIR_ACCEPTANCE_OUTBOUND_BLOCKED|air_bot_app_glue_required/u);
    const mount = output.match(/^AIR_ACCEPTANCE_MOUNT (.+)$/mu);
    assert.ok(mount, 'Observe the real createApp result, never set its mount flag');
    assert.deepEqual(JSON.parse(mount[1]), { mounted: true, policies: true, eligibility: true,
      readiness: true, durable: true, queue: true });
    const boundPort = Number(output.match(/Main page: http:\/\/localhost:(\d+)/u)[1]);
    assert.ok(boundPort > 0);
    const base = `http://127.0.0.1:${boundPort}`;
    const health = await json(base, '/healthz');
    assert.equal(health.ok, true);
    assert.equal(health.provider, 'ima-web-agent');
    assert.equal(health.knowledge_agent_qualification, 'v1');
    assert.equal(health.policyCapacity.knowledge_agent, 0);
    assert.ok(health.qualificationMonitor);
    const capacity = await json(base, '/internal/provider-a/capacity', { token: 'your-synthetic-internal' });
    assert.equal(capacity.schema_version, 'provider.a.capacity.v4');
    assert.equal(capacity.policies.knowledge_agent.max_concurrent, 0);
    assert.equal(capacity.features.durable_qa_tasks_v1, true);
    assert.equal(capacity.ready, false);
    assert.equal(capacity.answer_profile, 'ima_agent_auto');
    assert.equal(capacity.answer_profile_ready, false);
    const bootstrap = await json(base, '/api/admin/bootstrap', { token: 'your-synthetic-admin' });
    assert.equal(bootstrap.qualification.totalAccounts, 0);
    assert.equal(bootstrap.qualification.authorizedRequestCount, 0);
    assert.ok(bootstrap.enrollment);
    const eligibility = await json(base, '/api/admin/v2/accounts/eligibility', { token: 'your-synthetic-admin' });
    assert.equal(eligibility.schema_version, 'provider.a.admin.account-eligibility.v2');
    assert.deepEqual(eligibility.accounts, []);
    await json(base, '/api/admin/bootstrap', { token: 'synthetic-wrong', status: 401 });
    assert.deepEqual((await json(base, '/api/admin/qualifications/reports', { token: 'your-synthetic-admin' })).reports, []);
    assert.doesNotMatch(JSON.stringify({ health, capacity, bootstrap, eligibility }), /synthetic-(?:api|internal|admin)/u);
  } finally {
    if (!exited) child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    const result = await exit;
    clearTimeout(timer);
    assert.notEqual(result.signal, 'SIGKILL', 'Child must terminate without forced kill');
    assert.notEqual(result.code, 86, 'Startup attempted an outbound connection');
    assert.notEqual(result.code, 87, 'Startup attempted to read an actual env file');
  }
});

test('five Air basic proofs mount through app and execute five native durable HTTP tasks', { timeout: 20000 }, async t => {
  const directory = temporaryDirectory(t);
  const allowedPorts = new Set();
  let blockedConnections = 0;
  const connect = net.Socket.prototype.connect;
  t.mock.method(net.Socket.prototype, 'connect', function (...args) {
    const options = Array.isArray(args[0]) ? args[0][0] : typeof args[0] === 'object'
      ? args[0] : { port: args[0], host: args[1] };
    if (options.host !== '127.0.0.1' || !allowedPorts.has(Number(options.port))) {
      blockedConnections++;
      throw new Error('Non-fixture network connection forbidden');
    }
    return connect.apply(this, args);
  });
  t.after(() => assert.equal(blockedConnections, 0, 'No external connection attempts, including swallowed failures'));
  const config = getConfig(environment(directory));
  const accounts = new AirAccountDirectory({ storePath: config.webAgent.accountStorePath,
    keyPath: config.webAgent.accountStoreKeyPath, keyMaterial: 'synthetic-test-key-material' });
  for (let i = 0; i < 5; i++) {
    const id = `synthetic-account-${i}`;
    accounts.upsertCapturedAccount({ id, name: id, knowledgeBaseId: 'synthetic-kb',
      headers: { 'x-ima-cookie': `IMA-UID=${id}; IMA-TOKEN=synthetic-token`, 'x-ima-bkn': '123' },
      modelId: 'official_3', modelType: 3, maxConcurrent: 1 });
    const account = accounts.getAccount(id);
    account.runtime.retrievalPolicyQualifications = { group_knowledge: {
      answerBasis: 'knowledge', capabilityDigest: answerProfileContractDigest('classic_knowledge'),
    } };
    accounts.commitQualifications([{ account, proof: { level: 'basic', requests: 1, terminalCount: 1,
      passedModes: 1, knowledgeSourceCount: 1, unknownSourceCount: 0,
      capabilityDigest: knowledgeAgentContractDigest(), knowledgeScopeRef: hash('synthetic-kb'),
      principalFingerprint: account.principalFingerprint, verifiedAt: new Date().toISOString() } }]);
  }
  const proofsBefore = accounts.getPoolAccounts().map(row => row.knowledgeAgentQualification);
  const requests = [], pending = [];
  const upstream = http.createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    requests.push({ route: req.url, headers: req.headers, body: JSON.parse(text) });
    if (req.url.endsWith('/init_session')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ session_id: `synthetic-session-${requests.length}` }));
    } else if (req.url === '/cgi-bin/assistant/qa') {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write(`event: MESSAGE\ndata: ${JSON.stringify({ Text: answer })}\n\n`);
      pending.push(res);
    } else { res.statusCode = 500; res.end(); }
  });
  let server, runtime, pool, app;
  try {
    const upstreamBase = await listen(upstream);
    allowedPorts.add(upstream.address().port);
    runtime = createAirRuntime({ config });
    runtime.poolOptions.clientContextProvider.get = () => assert.fail('Native mode must not launch a context browser');
    const factory = runtime.poolOptions.clientFactory;
    pool = new IMAWebAgentPool({ ...config.webAgent, accounts: accounts.getPoolAccounts() }, {
      ...runtime.poolOptions,
      clientFactory: row => {
        const client = factory({ ...row, taskFetchImpl: (url, options) => {
          const target = new URL(url);
          assert.equal(target.origin, 'https://ima.qq.com');
          assert.ok(['/cgi-bin/session_logic/init_session', '/cgi-bin/assistant/qa'].includes(target.pathname));
          return taskTransportFetch(upstreamBase + target.pathname, options);
        } });
        client.fetchImpl = () => assert.fail('Legacy or external fetch is forbidden in this fixture');
        return client;
      },
    });
    const policies = runtime.attachPool(pool, accounts);
    const readiness = new AirWebReadiness({ directory: accounts, pool, policies, mode: 'knowledge_agent' });
    const conversations = new ConversationStore(config.conversations);
    app = createApp({ config, imaWebAgentClient: pool, accountDirectory: accounts,
      conversationStore: conversations, webReadiness: readiness, ...runtime.appOptions });
    const sync = () => synchronizeProviderAQueueCapacity({ askQueue: app.locals.imaQaAskQueue,
      config, pool, webReadiness: readiness });
    sync();
    runtime.attachApp({ app, accountDirectory: accounts, pool, synchronizeQueueCapacity: sync });
    server = http.createServer(app);
    const base = await listen(server);
    allowedPorts.add(server.address().port);
    const initial = await json(base, '/internal/provider-a/capacity', { token: 'your-synthetic-internal' });
    assert.equal(initial.policies.knowledge_agent.max_concurrent, 5);
    assert.equal(initial.policies.group_knowledge.max_concurrent, 5);
    assert.equal(initial.answer_profile, 'ima_agent_auto');
    assert.equal(initial.answer_profile_ready, false);
    assert.equal(initial.maxConcurrent, 5);
    assert.equal(initial.available, 5);
    assert.equal(initial.features.durable_qa_tasks_v1, true);
    assert.equal(readiness.snapshot().pending, 0);
    assert.ok(readiness.snapshot().accounts.every(row => row.state === 'ready'));
    const eligibility = await json(base, '/api/admin/v2/accounts/eligibility', { token: 'your-synthetic-admin' });
    assert.equal(eligibility.summary.strategies.knowledge_agent.capacity, 5);
    assert.equal(requests.length, 0, 'Mounting must not probe or refresh accounts');
    const tasks = await Promise.all(Array.from({ length: 5 }, async (_, i) => {
      const conversation = await json(base, '/api/conversations', { method: 'POST', status: 201, body: '{}' });
      return (await json(base, '/api/tasks', { method: 'POST', status: 202,
        headers: { 'Idempotency-Key': `synthetic-request-${i}` },
        body: JSON.stringify({ question: `Synthetic question ${i}`, conversationId: conversation.conversation.conversationId }) })).task;
    }));
    await until(() => pending.length === 5, 'five real pool leases executing concurrently');
    const busy = await json(base, '/internal/provider-a/capacity', { token: 'your-synthetic-internal' });
    assert.equal(busy.maxConcurrent, 5);
    assert.equal(busy.available, 0);
    assert.equal(busy.active, 5);
    assert.ok(readiness.snapshot().accounts.every(row => row.qualified && row.state === 'busy'));
    for (const res of pending) res.end('event: COMPLETED\ndata: {"Code":0}\n\n');
    for (const task of tasks) {
      const result = await until(async () => {
        const snapshot = await json(base, `/api/tasks/${task.id}`);
        assert.ok(!['failed', 'cancelled', 'indeterminate'].includes(snapshot.task.status), JSON.stringify(snapshot));
        return snapshot.task.status === 'succeeded' && snapshot;
      }, 'native task completion');
      assert.equal(result.snapshot.events.filter(event => event.event === 'done').length, 1);
      assert.equal(result.snapshot.events.filter(event => event.event === 'delta').map(event => event.data.text).join(''), answer);
    }
    const qa = requests.filter(row => row.route.endsWith('/qa'));
    assert.equal(qa.length, 5, 'No automatic upstream replay');
    assert.equal(new Set(qa.map(row => row.headers['x-ima-cookie'].match(/IMA-UID=([^;]+)/u)[1])).size, 5);
    for (const row of qa) {
      assert.equal(row.body.robot_type, 5);
      assert.equal(row.body.model_info.model_id, 'official_3');
      assert.equal(row.headers.extension_version, '5.11.2');
    }
    assert.equal(pool.accounts.reduce((sum, row) => sum + row.activeRequests, 0), 0);
    assert.equal(readiness.snapshot().schedulable, 5);
    assert.deepEqual(accounts.getPoolAccounts().map(row => row.knowledgeAgentQualification), proofsBefore);
    assert.ok(accounts.getPoolAccounts().every(row => row.webQualification === null));
  } finally {
    for (const res of pending) if (!res.writableEnded) res.destroy();
    app?.locals.durableQATasks?.close();
    pool?.stopAutoRefresh();
    await runtime?.close();
    if (server) await close(server);
    await close(upstream);
  }
});
