const { createApp } = require('./src/app');
const { registerAdminRoutes } = require('./src/admin-routes');
const { getConfig } = require('./src/config');
const { IMAWebAgentPool } = require('./src/ima-web-agent-pool');
const { WebAgentEnrollmentManager } = require('./src/web-agent-enrollment');
const { WebAgentAccountDirectory } = require('./src/web-agent-account-directory');
const { AccountPoolExerciseManager, AccountPoolExerciseReportStore } = require('./src/account-pool-exercise');
const { ConversationStore } = require('./src/conversation-store');
const { synchronizeProviderAQueueCapacity } = require('./src/provider-a-capacity');
const { loadRuntimeEnv } = require('./src/runtime-env');
const { WebReadiness } = require('./src/web-readiness');

async function main() {
  const envLoad = loadRuntimeEnv();
  const config = getConfig(process.env);
  assertProviderA(config);

  const accountDirectory = new WebAgentAccountDirectory({
    storePath: config.webAgent.accountStorePath,
    keyPath: config.webAgent.accountStoreKeyPath,
  });
  const conversationStore = new ConversationStore(config.conversations);
  seedAccountDirectory(accountDirectory, config.webAgent.accounts);
  validateDirectoryKnowledgeBase(accountDirectory, config.webAgent.sharedKnowledgeBaseId);
  let synchronizeQueueCapacity = () => {};

  const imaWebAgentClient = new IMAWebAgentPool(
    {
      ...config.webAgent,
      accounts: accountDirectory.getPoolAccounts(),
    },
    {
      onAccountStateChange(snapshot) {
        accountDirectory.recordRuntimeState(snapshot);
        synchronizeQueueCapacity();
      },
      onAccountCredentialsChange(accountId, snapshot) {
        accountDirectory.updateCredentialsFromClient(accountId, snapshot);
      },
    },
  );
  try {
    const refreshed = await imaWebAgentClient.ensureFreshAuth();
    imaWebAgentClient.persistRuntimeEnv();
    if (refreshed) {
      console.log('IMA Web Agent auth refreshed on startup');
    }
  } catch (error) {
    console.warn(`IMA Web Agent startup auth check failed: ${error.message}`);
  }
  imaWebAgentClient.startAutoRefresh();

  const webReadiness = new WebReadiness({ directory: accountDirectory, pool: imaWebAgentClient, mode: config.webAgent.webMode });
  const app = createApp({
    config,
    imaWebAgentClient,
    accountDirectory,
    conversationStore,
    webReadiness,
  });
  synchronizeQueueCapacity = () =>
    synchronizeProviderAQueueCapacity({
      askQueue: app.locals.imaQaAskQueue,
      config,
      pool: imaWebAgentClient,
      webReadiness,
    });
  synchronizeQueueCapacity();
  const accountPoolExerciseManager = new AccountPoolExerciseManager({
    askQueue: app.locals.imaQaAskQueue,
    accountDirectory,
    pool: imaWebAgentClient,
    requestTimeoutMs: config.concurrency.requestTimeoutMs,
    reportStore: new AccountPoolExerciseReportStore({
      storePath: config.exercises.reportStorePath,
      ttlMs: config.exercises.reportTtlMs,
      maxCount: config.exercises.reportMaxCount,
    }),
  });
  app.locals.accountPoolExerciseManager = accountPoolExerciseManager;
  const enrollmentManager = new WebAgentEnrollmentManager({
    config,
    accountDirectory,
    pool: imaWebAgentClient,
    onAccountsSynced: synchronizeQueueCapacity,
    onEnrolled: (id, question) => webReadiness.verify(id, question),
    onCancelVerification: id => webReadiness.cancel(id),
  });
  registerAdminRoutes(app, {
    config,
    accountDirectory,
    imaWebAgentClient,
    askQueue: app.locals.imaQaAskQueue,
    onAccountsSynced: synchronizeQueueCapacity,
    enrollmentManager,
    accountPoolExerciseManager,
    webReadiness,
  });

  app.listen(config.port, () => {
    console.log('IMA Provider A QA web app is running');
    console.log(`Main page: http://localhost:${config.port}`);
    console.log(`Embed page: http://localhost:${config.port}/embed.html`);
    console.log(`Provider: ${config.qaProvider}`);
    if (envLoad.loadedRuntimeEnv) {
      console.log(`Runtime env: ${envLoad.runtimeEnvPath}`);
    }
    console.log(`Model: ${config.webAgent.modelId}`);
  });
}

function assertProviderA(config) {
  if (config.qaProvider !== 'ima-web-agent') {
    throw new Error('此发布包只支持 Provider A（IMA Web Agent 账号池）');
  }
}

function validateDirectoryKnowledgeBase(accountDirectory, sharedKnowledgeBaseId) {
  const expected = String(sharedKnowledgeBaseId || '').trim();
  if (!expected) {
    return;
  }
  const mismatched = accountDirectory
    .listAccounts()
    .find((account) => account.knowledgeBaseId && account.knowledgeBaseId !== expected);
  if (mismatched) {
    throw new Error(`账号 ${mismatched.name} 不属于当前配置的 IMA 共享知识库，拒绝启动`);
  }
}

function seedAccountDirectory(accountDirectory, accounts = []) {
  for (const account of accounts) {
    if (!account?.headers || !account?.knowledgeBaseId) {
      continue;
    }
    if (accountDirectory.getAccount(account.id || account.name)) {
      continue;
    }
    accountDirectory.upsertCapturedAccount({
      id: account.id,
      name: account.name,
      knowledgeBaseId: account.knowledgeBaseId,
      headers: account.headers,
      runtimeEnvPath: account.runtimeEnvPath,
      modelId: account.modelId,
      modelType: account.modelType,
      tokenExpiresAt: account.tokenExpiresAt,
      refreshTokenExpiresAt: account.refreshTokenExpiresAt,
      refreshSkewMs: account.refreshSkewMs,
      refreshIntervalMs: account.refreshIntervalMs,
      source: 'env-seed',
    });
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  assertProviderA,
  seedAccountDirectory,
  validateDirectoryKnowledgeBase,
};
