import {pairedSandbox} from '../test-support/paired-sandbox.mjs';import {spawn} from 'node:child_process';import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
const args=process.argv.slice(2),website=args[args.indexOf('--website')+1];if(!args.includes('--website')||!path.isAbsolute(website))throw Error('absolute_website_candidate_required');
const f=await pairedSandbox({port:4620,monitorPort:4623,websiteUrl:'http://127.0.0.1:4621/api/qa/health',slow:true,publicAccess:true});
const runtime=path.join(f.dir,'website');fs.mkdirSync(runtime,{mode:0o700});
const child=spawn(process.execPath,['server.mjs'],{cwd:website,stdio:['ignore','ignore','inherit'],env:{PATH:process.env.PATH,PORT:'4621',DEMO_RUNTIME_DIR:runtime,DEMO_COOKIE_NAME:'qa_paired_synthetic',DEMO_COOKIE_SECRET:'synthetic-paired-cookie',DEMO_DISABLE_ADMIN:'1',PROVIDER_A_BASE_URL:f.url,PROVIDER_A_API_TOKEN:'synthetic-api',PROVIDER_A_INTERNAL_SERVICE_TOKEN:'synthetic-service',PROVIDER_A_KNOWLEDGE_SCOPE_REF:createHash('sha256').update(f.kb).digest('hex')}});
console.log(JSON.stringify({syntheticOnly:true,provider:f.url,embed:f.url+'/embed.html',admin:f.url+'/admin.html',website:'http://127.0.0.1:4621/',status:'http://127.0.0.1:4623/'}));
let closing=false;async function close(){if(closing)return;closing=true;child.kill('SIGTERM');if(child.exitCode===null)await new Promise(r=>child.once('exit',r));await f.close();}
process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
