#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import configuration from '../src/provider-a-release.js';

// Starts only a disposable, network-disabled, empty-account container.
const image = process.argv[2];
const name = `ima-onboarding-check-${crypto.randomBytes(6).toString('hex')}`;
let directory;
let owned = false;
let phase = 'prepare';
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
try {
  if (!/^[a-z0-9][a-z0-9./:_@-]+$/.test(image || '')) throw Error();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ima-onboarding-check-'));
  const file = path.join(directory, 'provider.env');
  fs.writeFileSync(file, configuration.buildProviderAEnv({ sharedKnowledgeBaseId: '999000111' })
    + `IMA_QA_API_TOKEN=${configuration.createSecret()}\nIMA_QA_INTERNAL_SERVICE_TOKEN=${configuration.createSecret()}\n`
    + `IMA_WEB_AGENT_SHARED_KNOWLEDGE_BASE_SHARE_URL=https://ima.qq.com/wiki/?shareId=${'a'.repeat(64)}\n`, { mode: 0o600, flag: 'wx' });
  phase = 'container_start';
  docker(['run', '-d', '--name', name, '--network', 'none', '--env-file', file, image]);
  owned = true;
  phase = 'container_checks';
  const script = `let stage='startup';(async()=>{const assert=require('node:assert/strict');const base='http://127.0.0.1:3000';
    let healthy=false;for(let i=0;i<40;i++){try{if((await fetch(base+'/healthz')).ok){healthy=true;break;}}catch{}await new Promise(r=>setTimeout(r,250));}assert.ok(healthy);
    const get=(url,token,method='GET')=>fetch(base+url,{method,headers:token?{authorization:'Bearer '+token}:{},signal:AbortSignal.timeout(5000)});
    stage='admin_auth';assert.equal((await get('/api/admin/bootstrap')).status,401);
    stage='enrollment_contract';const bootstrap=await (await get('/api/admin/bootstrap',process.env.IMA_QA_ADMIN_TOKEN)).json();assert.equal(bootstrap.enrollment.authorizationProtocol,'shared_library_membership_v1');
    assert.equal(bootstrap.enrollment.supportsAdminPageQr,false);
    stage='empty_capacity';const capacity=await (await get('/internal/provider-a/capacity',process.env.IMA_QA_INTERNAL_SERVICE_TOKEN)).json();assert.equal(capacity.schemaVersion,1);assert.equal(capacity.available,0);
    stage='credential_separation';assert.equal((await get('/internal/provider-a/capacity',process.env.IMA_QA_API_TOKEN)).status,401);
    assert.equal((await get('/api/conversations')).status,401);assert.equal((await get('/api/conversations',process.env.IMA_QA_API_TOKEN)).status,200);
    stage='admin_page';assert.equal((await get('/admin.html')).status,200);
    console.log(JSON.stringify({emptyPool:true,adminProtected:true,enrollmentContract:true,ordinaryInternalSeparation:true,realQaVerified:false}));
  })().catch(()=>{console.log(JSON.stringify({failureStage:stage}));process.exitCode=1;})`;
  const result = JSON.parse(docker(['exec', name, 'node', '-e', script]));
  console.log(JSON.stringify(result));
} catch (error) {
  // Only allow fixed diagnostic stages, never command/error text or runtime output.
  try {
    const reported = JSON.parse(String(error.stdout || '')).failureStage;
    if (['startup', 'admin_auth', 'enrollment_contract', 'empty_capacity',
      'credential_separation', 'admin_page'].includes(reported)) phase = reported;
  } catch {}
  console.error(JSON.stringify({ emptyPool: false, phase, credentialsPrinted: false })); process.exitCode = 1;
} finally {
  if (owned) { try { docker(['rm', '-f', name]); } catch { console.error('Disposable container cleanup failed; inspect ima-onboarding-check containers.'); process.exitCode = 1; } }
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
}
