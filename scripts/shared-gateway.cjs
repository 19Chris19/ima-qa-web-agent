'use strict';

const { readFileSync } = require('node:fs');
const { createSharedGateway } = require('../src/shared-gateway');

// Explicit private file only: do not inherit Provider's dotenv or runtime state.
try {
  const configPath = process.env.SHARED_GATEWAY_CONFIG;
  if (!configPath) throw new Error('config_required');
  const read = () => JSON.parse(readFileSync(configPath, 'utf8'));
  const config = read();
  const port = config.port ?? 8790;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid_port');
  const gateway = createSharedGateway(config);
  gateway.server.on('error', () => { console.error('Gateway listener failed'); process.exitCode = 1; });
  gateway.listen(port);
  process.on('SIGHUP', () => {
    try { gateway.replaceSites(read().sites); }
    catch { console.error('Gateway site reload rejected; previous registry retained'); }
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    gateway.server.close();
    gateway.server.closeAllConnections();
  });
} catch {
  console.error('Gateway configuration invalid');
  process.exitCode = 1;
}
