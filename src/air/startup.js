'use strict';

const { IMAFirstPartyClientContextProvider } = require('./ima-first-party-client-context');
const { ProviderAObservationExporter } = require('./observability/exporter');
const { ObservationSocketTransport } = require('./observability/socket-transport');
const { KnowledgeAgentQualificationManager, KnowledgeAgentQualificationReportStore } = require('./knowledge-agent-qualification-job');
const { ProtocolDiagnosticRecorder } = require('./protocol-diagnostic-recorder');
const { QualificationMonitor } = require('./qualification-monitor');
const { IMAWebAgentClient } = require('./ima-web-agent-client');
const { AirPolicyCapacity } = require('./policy-capacity');
const { createBotServerDependencies, createBotQualificationDependencies } = require('../bot-server-glue');
const { registerAirAdminRoutes } = require('./admin');

function createAirRuntime({ config, constructors = {} }) {
  if (!config.airBot?.enabled) return null;
  const air = config.airBot;
  const merged = { ...config, ...air };
  const types = { IMAFirstPartyClientContextProvider, ProviderAObservationExporter, ObservationSocketTransport,
    KnowledgeAgentQualificationManager, KnowledgeAgentQualificationReportStore, ...constructors };
  const dependencies = createBotServerDependencies({ config: merged, constructors: types });
  const recorder = air.protocolDiagnostics.enabled ? new ProtocolDiagnosticRecorder(air.protocolDiagnostics) : null;
  let policies, monitor;
  return {
    appOptions: { ...dependencies.appOptions },
    poolOptions: { ...dependencies.poolOptions,
      policyEligibility: (account, requestOptions = {}) => {
        const policy = requestOptions.retrievalPolicy;
        if (!policy) return true;
        const current = policies?.accounts().find(row => row.id === account.id);
        return Boolean(current && policies.eligible(current, policy));
      },
      clientFactory: account => new IMAWebAgentClient({ ...account, answerProfile: account.answerProfile || air.answerProfile,
        clientContextProvider: dependencies.poolOptions.clientContextProvider,
        protocolUnknownObserver: descriptor => recorder?.observe(descriptor),
        protocolErrorObserver: code => recorder?.recordError(code),
        protocolNormalizationObserver: category => recorder?.recordNormalization(category) }) },
    attachPool(pool, directory) {
      policies = new AirPolicyCapacity({ directory, pool, profile: air.answerProfile, capabilityDigest: air.capabilityDigest });
      monitor = new QualificationMonitor({ read: () => policies.qualificationAlertSnapshot(),
        observation: dependencies.appOptions.observation, transport: dependencies.observationTransport });
      this.appOptions.airPolicyCapacity = policies;
      this.appOptions.botCompatibility = { snapshot: () => policies.snapshot() };
      this.appOptions.qualificationMonitor = monitor;
      return policies;
    },
    attachApp({ app, accountDirectory, pool, accountPoolExerciseManager, synchronizeQueueCapacity }) {
      const facade = { stats: (...args) => pool.stats(...args), syncAccounts: accounts => pool.syncAccounts(accounts),
        policyCapacitySnapshot: () => policies.policyCapacitySnapshot(),
        ...(pool.renewQuarantinedCredentials ? { renewQuarantinedCredentials: (...args) => pool.renewQuarantinedCredentials(...args) } : {}) };
      const qualification = createBotQualificationDependencies({ config: merged, app, accountDirectory,
        pool: facade, accountPoolExerciseManager, synchronizeQueueCapacity, constructors: types });
      registerAirAdminRoutes(app, { config, accountDirectory, policies,
        manager: qualification.adminOptions.knowledgeAgentQualificationManager, sync: synchronizeQueueCapacity });
      return qualification;
    },
    start() { dependencies.observationTransport?.start(); },
    async close() { monitor?.stop(); await dependencies.observationTransport?.close(); },
  };
}

function airHealthFields({ recentContextConsumer, qualificationMonitor, airPolicyCapacity }) {
  return { recentContext: { enabled: Boolean(recentContextConsumer), contracts: ['v1', 'v2'] },
    knowledge_agent_qualification: 'v1', policyCapacity: airPolicyCapacity.policyCapacitySnapshot(),
    qualificationMonitor: qualificationMonitor?.snapshot() };
}

module.exports = { createAirRuntime, airHealthFields };
