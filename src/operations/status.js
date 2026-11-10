'use strict';
const { publicOperations } = require('../operations-overview');
function composeStatus({ overview, checks = {}, now = Date.now() }) {
  const age = overview ? now-Date.parse(overview.observedAt) : Infinity;
  const fresh = age>=0 && age<=15000;
  const ops=fresh?publicOperations(overview):null;
  const check = key => {
    const c=checks[key], age=c?now-c.at:Infinity;
    return {state:age<0||age>90000?'unknown':c.ok?'normal':'outage', observedAt:c?.at||null};
  };
  const components={ provider:{state:ops?.state||'unknown',observedAt:overview?.observedAt||null}, website:check('website'),
    capacity:{state:!ops?'unknown':ops.maintenance?'maintenance':ops.capacity===null?'unknown':ops.capacity===0?'outage':ops.free===0?'busy':ops.ready<ops.total?'degraded':'normal'},
    persistence:{state:!ops||ops.persistence.ready===null?'unknown':ops.persistence.ready?'normal':'outage'}, private_entry:check('private_entry'),
    source_preview:{state:!fresh||!['normal','degraded'].includes(overview.sourcePreviewState)?'unknown':overview.sourcePreviewState} };
  const core=['provider','website','capacity','persistence'].map(k=>components[k].state);
  const state=['outage','maintenance','unknown','degraded','busy','normal'].find(x=>core.includes(x));
  return { schema:'provider_status_v1', observedAt:now, state, components, capacity:ops?.capacity??null,
    ready:ops?.ready??null,total:ops?.total??null,active:ops?.active??null,queued:ops?.queued??null,
    qa:ops?.metrics||null, localHealthOnly:true, staleAfterMs:15000 };
}
module.exports={composeStatus};
