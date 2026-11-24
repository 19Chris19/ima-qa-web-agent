'use strict';
const { COMPONENTS, STATES } = require('./history');
const { safeMetrics } = require('../operations-overview');
const count=v=>Number.isSafeInteger(v)&&v>=0?v:null;
const STATUS_URL = 'http://127.0.0.1:4610/api/status?view=recent';
function createStatusReader({ read = fetch, now = Date.now, expectedSynthetic=false } = {}) {
  let inflight=null, cached=null, cachedAt=0;
  return async () => {
    if (cached && now()-cachedAt < 1000 && now()-cachedAt>=0) return cached;
    if (inflight) return inflight;
    inflight=(async()=>{
      const response=await read(STATUS_URL,{ redirect:'error', signal:AbortSignal.timeout(1500) });
      if(!response.ok)throw Error('operations_status_unavailable');
      let bytes=0;const chunks=[];
      for await(const chunk of response.body){bytes+=chunk.byteLength;if(bytes>131072)throw Error('operations_status_too_large');chunks.push(Buffer.from(chunk));}
      const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(value.schema!=='provider_status_v1'||!Number.isFinite(value.observedAt))throw Error('operations_status_invalid');
      if(typeof value.synthetic!=='boolean'||value.synthetic!==expectedSynthetic)throw Error('operations_status_source_mismatch');
      // Do not forward any unexpected monitor fields or private metadata.
      const components=Object.fromEntries(COMPONENTS.map(key=>[key,{state:STATES.has(value.components?.[key]?.state)?value.components[key].state:'unknown'}]));
      let recent;
      const raw=value.recent;
      if(raw?.schema==='provider_recent_status_v1' && [raw.from,raw.to,raw.observedAt].every(Number.isFinite)) {
        recent={schema:raw.schema,from:raw.from,to:raw.to,observedAt:raw.observedAt,sampleMs:5000,bucketMs:10000,maxPoints:120,points:Math.min(120,count(raw.points)||0),components:{}};
        for(const key of COMPONENTS) if(Array.isArray(raw.components?.[key])&&raw.components[key].length===60)recent.components[key]=raw.components[key].map(b=>({from:Number.isFinite(b.from)?b.from:null,to:Number.isFinite(b.to)?b.to:null,state:STATES.has(b.state)?b.state:'unknown',samples:Math.min(2,count(b.samples)||0),expectedSamples:Math.min(2,count(b.expectedSamples)||0),coverage:Number.isFinite(b.coverage)?Math.max(0,Math.min(1,b.coverage)):0}));
      }
      cached={schema:value.schema,synthetic:value.synthetic,observedAt:value.observedAt,state:STATES.has(value.state)?value.state:'unknown',components,capacity:count(value.capacity),ready:count(value.ready),total:count(value.total),active:count(value.active),queued:count(value.queued),qa:safeMetrics(value.qa),localHealthOnly:true,staleAfterMs:15000,...(recent?{recent}:{})};cachedAt=now();
      return cached;
    })();
    try{return await inflight;}finally{inflight=null;}
  };
}
module.exports={createStatusReader,STATUS_URL};
