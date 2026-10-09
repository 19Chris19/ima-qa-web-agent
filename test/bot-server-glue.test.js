'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBotServerDependencies, createBotQualificationDependencies } = require('../src/bot-server-glue');

test('server glue is inert when disabled and fails explicitly for missing enabled extensions', () => {
  const result = createBotServerDependencies({ config: { qaProvider: 'openapi-mimo' } });
  assert.equal(result.poolOptions.clientContextProvider, null);
  assert.deepEqual(result.appOptions, { observation: null, recentContextConsumer: null });
  assert.throws(() => createBotServerDependencies({ config: { qaProvider: 'ima-web-agent' } }),
    { code: 'bot_extension_missing' });
  assert.throws(() => createBotServerDependencies({ config: { observability: { enabled: true } } }),
    { code: 'bot_extension_missing' });
});

test('server glue preserves exact shared dependency identities without starting transport or QA', () => {
  const events = [];
  class Context { constructor(options) { this.options = options; } }
  class Transport {
    constructor(options) { this.options = options; }
    start() { throw new Error('must be explicitly started by server owner'); }
    enqueue(event) { events.push(event); }
  }
  class Exporter { constructor(options) { this.options = options; } }
  const result = createBotServerDependencies({
    config: { qaProvider: 'ima-web-agent', webAgent: { browserPath: '/synthetic/browser' },
      observability: { enabled: true, socketPath: '/synthetic/observe.sock', maxQueue: 16 },
      recentContext: { enabled: true, baseUrl: 'http://127.0.0.1:9999', token: 'synthetic-context-token' } },
    constructors: { IMAFirstPartyClientContextProvider: Context,
      ObservationSocketTransport: Transport, ProviderAObservationExporter: Exporter },
  });
  assert.deepEqual(result.poolOptions.clientContextProvider.options, { browserPath: '/synthetic/browser' });
  assert.deepEqual(result.observationTransport.options, { socketPath: '/synthetic/observe.sock', maxQueue: 16 });
  result.appOptions.observation.options.enqueue({ phase: 'synthetic' });
  assert.deepEqual(events, [{ phase: 'synthetic' }]);
  assert.equal(typeof result.appOptions.recentContextConsumer.consume, 'function');
});

test('qualification glue shares queue, conflict manager and callbacks with enrollment/admin', () => {
  class Manager { constructor(options) { this.options = options; } }
  class Store { constructor(options) { this.options = options; } }
  const queue = {};
  const app = { locals: { imaQaAskQueue: queue } };
  const accountDirectory = {};
  const pool = {};
  const exercise = {};
  const synchronizeQueueCapacity = () => {};
  const options = { config: { concurrency: { requestTimeoutMs: 1234 },
    webAgent: { accountStorePath: '/synthetic/accounts.json' } }, app, accountDirectory, pool,
    accountPoolExerciseManager: exercise, synchronizeQueueCapacity };
  assert.throws(() => createBotQualificationDependencies(options), { code: 'bot_extension_missing' });
  const result = createBotQualificationDependencies({ ...options, constructors: {
    KnowledgeAgentQualificationManager: Manager, KnowledgeAgentQualificationReportStore: Store,
  } });
  const manager = result.adminOptions.knowledgeAgentQualificationManager;
  assert.equal(result.enrollmentOptions.qualificationManager, manager);
  assert.equal(app.locals.knowledgeAgentQualificationManager, manager);
  assert.equal(manager.options.askQueue, queue);
  assert.equal(manager.options.pool, pool);
  assert.equal(manager.options.accountDirectory, accountDirectory);
  assert.equal(manager.options.onAccountsSynced, synchronizeQueueCapacity);
  assert.deepEqual(manager.options.conflictManagers, [exercise]);
  assert.equal(manager.options.reportStore.options.storePath, '/synthetic/qualification-reports.json');
  assert.equal(manager.options.requestTimeoutMs, 1234);
  const disabled = createBotQualificationDependencies({ config: {}, app });
  assert.equal(disabled.enrollmentOptions.qualificationManager, null);
});
