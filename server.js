const { createApp } = require('./src/app');
const { getConfig } = require('./src/config');
const { IMAClient } = require('./src/ima-client');
const { IMAWebAgentClient } = require('./src/ima-web-agent-client');
const { MIMOClient } = require('./src/mimo-client');
const { loadRuntimeEnv } = require('./src/runtime-env');

async function main() {
  const envLoad = loadRuntimeEnv();
  const config = getConfig(process.env);
  const qaProvider = config.qaProvider || 'openapi-mimo';
  const imaWebAgentClient =
    qaProvider === 'ima-web-agent' ? new IMAWebAgentClient(config.webAgent) : null;
  if (imaWebAgentClient) {
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
  }

  const app = createApp({
    config,
    imaClient: qaProvider === 'openapi-mimo' ? new IMAClient(config.ima) : null,
    mimoClient: qaProvider === 'openapi-mimo' ? new MIMOClient(config.mimo) : null,
    imaWebAgentClient,
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
