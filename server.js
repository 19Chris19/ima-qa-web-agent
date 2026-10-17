const { createApp } = require('./src/app');
const { getConfig } = require('./src/config');
const { IMAClient } = require('./src/ima-client');
const { MIMOClient } = require('./src/mimo-client');
const { LocalRAGClient } = require('./src/local-rag-client');
const { ConversationStore } = require('./src/conversation-store');
const { loadRuntimeEnv } = require('./src/runtime-env');

async function main() {
  const envLoad = loadRuntimeEnv();
  const config = getConfig(process.env);
  // Both IMA entrypoints share the same asynchronous, fenced implementation.
  if (config.qaProvider === 'ima-web-agent' || config.airBot?.enabled) {
    return require('./provider-a-server').main({ config, envLoad });
  }
  const qaProvider = config.qaProvider || 'openapi-mimo';
  const conversationStore = new ConversationStore(config.conversations);
  const app = createApp({
    config,
    imaClient: qaProvider === 'openapi-mimo' ? new IMAClient(config.ima) : null,
    mimoClient:
      qaProvider === 'openapi-mimo' || qaProvider === 'local-rag-mimo'
        ? new MIMOClient(config.mimo)
        : null,
    localRagClient: qaProvider === 'local-rag-mimo' ? new LocalRAGClient(config.localRag) : null,
    conversationStore,
  });
  app.listen(config.port, () => {
    console.log('IMA shared knowledge QA web app is running');
    console.log(`Main page: http://localhost:${config.port}`);
    console.log(`Embed page: http://localhost:${config.port}/embed.html`);
    console.log(`Provider: ${qaProvider}`);
    if (envLoad.loadedRuntimeEnv) {
      console.log(`Runtime env: ${envLoad.runtimeEnvPath}`);
    }
    console.log(
      `Model: ${
        qaProvider === 'ima-web-agent' ? config.webAgent.modelId : config.mimo.model
      }`,
    );
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
