'use strict';

const path = require('node:path');
const { RecentContextConsumer } = require('./bot-recent-context');

function required(constructors, name) {
  if (typeof constructors[name] !== 'function') {
    throw Object.assign(new Error(`bot_extension_missing:${name}`), { code: 'bot_extension_missing' });
  }
  return constructors[name];
}

// Call after the account-store fence. Importing this module performs no I/O.
function createBotServerDependencies({ config, constructors = {} }) {
  const webAgent = config.qaProvider === 'ima-web-agent';
  const Context = webAgent ? required(constructors, 'IMAFirstPartyClientContextProvider') : null;
  const Transport = config.observability?.enabled
    ? required(constructors, 'ObservationSocketTransport') : null;
  const Exporter = Transport ? required(constructors, 'ProviderAObservationExporter') : null;
  const clientContextProvider = Context ? new Context({ browserPath: config.webAgent.browserPath }) : null;
  const observationTransport = Transport ? new Transport({
    socketPath: config.observability.socketPath, maxQueue: config.observability.maxQueue,
  }) : null;
  const observation = Exporter ? new Exporter({ enqueue: event => observationTransport.enqueue(event) }) : null;
  const recentContextConsumer = config.recentContext?.enabled
    ? new RecentContextConsumer(config.recentContext) : null;
  return {
    poolOptions: { clientContextProvider },
    appOptions: { observation, recentContextConsumer },
    observationTransport,
  };
}

// Construct only; no qualification run or enrollment starts here.
function createBotQualificationDependencies({ config, app, accountDirectory, pool,
  accountPoolExerciseManager, synchronizeQueueCapacity, constructors = {} }) {
  let knowledgeAgentQualificationManager = null;
  if (accountDirectory && pool) {
    const Manager = required(constructors, 'KnowledgeAgentQualificationManager');
    const Store = required(constructors, 'KnowledgeAgentQualificationReportStore');
    knowledgeAgentQualificationManager = new Manager({
      askQueue: app.locals.imaQaAskQueue, accountDirectory, pool,
      requestTimeoutMs: config.concurrency.requestTimeoutMs,
      onAccountsSynced: synchronizeQueueCapacity,
      conflictManagers: accountPoolExerciseManager ? [accountPoolExerciseManager] : [],
      reportStore: new Store({
        storePath: path.join(path.dirname(config.webAgent.accountStorePath), 'qualification-reports.json'),
      }),
    });
  }
  app.locals.knowledgeAgentQualificationManager = knowledgeAgentQualificationManager;
  return {
    enrollmentOptions: { qualificationManager: knowledgeAgentQualificationManager },
    adminOptions: { knowledgeAgentQualificationManager },
  };
}

module.exports = { createBotServerDependencies, createBotQualificationDependencies };
