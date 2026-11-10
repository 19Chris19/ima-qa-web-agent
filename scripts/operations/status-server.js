'use strict';
// Separate process; does not import Provider startup or read account/profile files.
const http=require('node:http'), fs=require('node:fs/promises'), path=require('node:path');
const {StatusHistory}=require('../../src/operations/history');
const {composeStatus}=require('../../src/operations/status');
async function readLocal(url) {
  const parsed=new URL(url);
  if(parsed.protocol!=='http:'||parsed.hostname!=='127.0.0.1'||parsed.username||parsed.password)throw Error('loopback_only');
  const r=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(2000)});
  if(!r.ok)throw Error('status_unavailable');
  let size=0;const chunks=[];for await(const chunk of r.body){size+=chunk.byteLength;if(size>256*1024)throw Error('status_too_large');chunks.push(Buffer.from(chunk));}return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function createStatusServer({directory,port=4610,overviewUrl='http://127.0.0.1:3118/api/admin/overview',
  websiteUrl='http://127.0.0.1:4317/api/qa/health',privateEntryUrl=null,hostHealthPath=null,synthetic=false,
  read=readLocal,now=Date.now,poll=true}={}) {
  if(!directory)throw Error('private_history_directory_required');
  const history=await new StatusHistory({directory,now}).initialize();let stopped=false,timer,overview=null,checks={},networkAt=-Infinity,last=null,historyCache=await history.summary(),historyAt=0;
  async function tick(){
    try{const r=await read(overviewUrl);if(r.overview?.schema==='provider_operations_v1')overview=r.overview;}catch{/* Prior value expires; never keep stale green. */}
    if(now()-networkAt>=30000){networkAt=now();await Promise.all([...(hostHealthPath ? [] : [['website',websiteUrl]]),...(privateEntryUrl ? [['private_entry',privateEntryUrl]] : [])].map(async([key,url])=>{
      try{const v=await read(url);checks[key]={at:now(),ok:key==='website'?v.ready===true&&v.authenticated===true:v.ready===true};}catch{checks[key]={at:now(),ok:false};}
    }));
      if(hostHealthPath){try{const h=JSON.parse(await fs.readFile(hostHealthPath,'utf8'));const at=Date.parse(h.observedAt);if(Number.isFinite(at)&&now()-at>=0&&now()-at<=90000){checks.website={at,ok:h.websiteAndProvider?.ready===true&&h.websiteAndProvider?.authenticated===true};if(h.tailnet)checks.private_entry={at,ok:h.tailnet.ready===true};else delete checks.private_entry;}else {delete checks.private_entry;delete checks.website;}}catch{delete checks.private_entry;delete checks.website;}}
    }
    last=composeStatus({overview,checks,now:now()});await history.append(last);
    if(now()-historyAt>=60000){historyCache=await history.summary();historyAt=now();}
  }
  async function loop(){try{await tick();}catch{history.error=true;}finally{if(!stopped)timer=setTimeout(loop,5000);}}
  const assets={'/':'status.html','/status.css':'status.css','/status.js':'status.js','/poller.js':'../admin-poller.js'};
  const server=http.createServer(async(req,res)=>{
    const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"};
    if(req.headers.host!==`127.0.0.1:${server.address()?.port}`||req.socket.remoteAddress!=='127.0.0.1'){res.writeHead(403,headers);return res.end();}
    if(req.method!=='GET'){res.writeHead(405,headers);return res.end();}
    const pathname=new URL(req.url,'http://127.0.0.1').pathname;
    if(pathname==='/api/status'){
      const value=composeStatus({overview,checks,now:now()});
      // Cached history has a timestamp; collector errors must remain visible.
      res.writeHead(200,{...headers,'Content-Type':'application/json'});
      return res.end(JSON.stringify({...value,synthetic,history:{...historyCache,storageError:history.error},historyObservedAt:historyAt}));
    }
    if(!assets[pathname]){res.writeHead(404,headers);return res.end();}
    const file=assets[pathname];res.writeHead(200,{...headers,'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html; charset=utf-8'});
    res.end(await fs.readFile(path.join(__dirname,'../../public/operations',file)));
  });
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));if(poll)void loop();
  return {server,history,tick,async close(){stopped=true;clearTimeout(timer);await history.pending;await new Promise(resolve=>server.close(resolve));}};
}
if(require.main===module)createStatusServer({directory:process.env.PROVIDER_STATUS_DIRECTORY,hostHealthPath:process.env.PROVIDER_HOST_HEALTH_PATH||null,port:Number(process.env.PORT||4610)})
  .then(()=>console.log('Private read-only status process started')).catch(()=>{console.error('Status startup failed; verify private directory and local configuration');process.exitCode=1;});
module.exports={createStatusServer,readLocal};
