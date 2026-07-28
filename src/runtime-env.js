const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

function defaultRuntimeEnvPath(appDir) {
  return path.resolve(appDir, '..', '..', 'runtime', 'ima-web-agent.env');
}

function loadRuntimeEnv({ appDir = path.resolve(__dirname, '..'), env = process.env } = {}) {
  const appEnvPath = path.join(appDir, '.env');
  const appResult = dotenv.config({ path: appEnvPath, processEnv: env });
  const runtimeEnvPath =
    String(env.IMA_WEB_AGENT_RUNTIME_ENV_PATH || '').trim() || defaultRuntimeEnvPath(appDir);

  let runtimeResult = { parsed: undefined };
  if (fs.existsSync(runtimeEnvPath)) {
    runtimeResult = dotenv.config({ path: runtimeEnvPath, processEnv: env });
  }

  return {
    appEnvPath,
    runtimeEnvPath,
    loadedAppEnv: Boolean(appResult.parsed),
    loadedRuntimeEnv: Boolean(runtimeResult.parsed),
  };
}

module.exports = {
  defaultRuntimeEnvPath,
  loadRuntimeEnv,
};
