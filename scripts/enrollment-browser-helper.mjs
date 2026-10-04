import fs from 'node:fs';
import { isAbsolute } from 'node:path';
import { chromium } from 'playwright-core';

// A dedicated browser with temporary profiles; never attach to a daily browser.
let server;
try {
  const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  if (!/^[a-f0-9]{64}$/.test(config.key) || !Number.isInteger(config.port)
    || config.port < 1 || config.port > 65535
    || typeof config.browserPath !== 'string' || !isAbsolute(config.browserPath)) {
    throw new Error('Invalid private helper configuration');
  }
  server = await chromium.launchServer({
    executablePath: config.browserPath,
    headless: false,
    host: '127.0.0.1',
    port: config.port,
    wsPath: config.key,
    args: ['--no-first-run', '--no-default-browser-check'],
  });
  console.log('Enrollment browser helper ready (loopback only).');
} catch {
  console.error('Enrollment browser helper failed to start.');
  process.exit(1);
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
  await server.close();
  process.exit(0);
});
