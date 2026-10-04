const { execFileSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');

async function main() {
  const [image, platform] = process.argv.slice(2);
  if (!image || !['linux/amd64', 'linux/arm64'].includes(platform)) throw Error('Image and supported platform required');
  const dir = mkdtempSync(join(tmpdir(), 'provider-image-'));
  const name = `provider-image-${randomUUID()}`;
  const run = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const secret = () => randomBytes(32).toString('hex');
    const env = ['IMA_QA_PROVIDER=ima-web-agent', 'PORT=3000',
      'IMA_WEB_AGENT_SHARED_KNOWLEDGE_BASE_ID=999000111',
      `IMA_QA_API_TOKEN=${secret()}`, `IMA_QA_ADMIN_TOKEN=${secret()}`,
      `IMA_QA_INTERNAL_SERVICE_TOKEN=${secret()}`,
      'IMA_WEB_AGENT_ACCOUNT_STORE_PATH=/app/runtime/accounts.json',
      'IMA_WEB_AGENT_ACCOUNT_STORE_KEY_PATH=/app/runtime/accounts.key',
      'IMA_QA_CONVERSATION_STORE_PATH=/app/runtime/conversations.json'];
    writeFileSync(join(dir, 'config'), env.join('\n') + '\n', { mode: 0o600 });
    run(['run', '-d', '--name', name, '--network', 'none', '--platform', platform, '--env-file', join(dir, 'config'), image]);
    for (let attempt = 0; ; attempt++) {
      try {
        run(['exec', name, 'node', '-e', "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]);
        break;
      } catch { if (attempt >= 60) throw Error('Image startup failed'); await new Promise(r => setTimeout(r, 1000)); }
    }
    run(['exec', name, 'node', '-e', "const f=require('fs'); for(const p of ['/app/.env','/app/.env.local','/app/browser-profiles']) if(f.existsSync(p)) process.exit(1); fetch('http://127.0.0.1:3000/internal/provider-a/capacity').then(r=>process.exit(r.status===401?0:1))"]);
    console.log(JSON.stringify({ platform, startup: 'PASS', unauthorizedInternal: 'PASS', network: 'none', realIMA: 'NOT RUN' }));
  } finally {
    try { run(['rm', '-f', name]); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(() => { console.error('Isolated image verification failed (private configuration and logs withheld).'); process.exitCode = 1; });
