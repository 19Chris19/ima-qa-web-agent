'use strict';
const http = require('node:http');
const { once } = require('node:events');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { monitorEventLoopDelay, performance } = require('node:perf_hooks');
const p95 = values => [...values].sort((a,b) => a-b)[Math.max(0, Math.ceil(values.length * .95) - 1)] || 0;
async function measure(modulePath) {
  const { parseIMAWebAgentStream } = require(modulePath);
  const packet = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const body = Array.from({length:8}, (_,i) => packet('CONTEXT_REFERENCES', { [String(i)]: [{ sourceType: 0,
    title: 'Scrubbed source', jumpUrl: `https://example.org/fixture-${i%3}`, content: 'Scrubbed excerpt' }] })).join('')
    + Array.from({length:400}, () => packet('MESSAGE', { Text: 'Scrubbed stream fragment. '.repeat(3) })).join('')
    + packet('COMPLETED', { Code: 0 });
  const server = http.createServer((req,res) => { res.end('ok'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/healthz`, latencies=[], first=[], gaps=[];
  const cpu = process.cpuUsage(), resources = process.resourceUsage(), startRSS=process.memoryUsage().rss;
  let peakRSS=startRSS;const loop = monitorEventLoopDelay({resolution:1});loop.enable();
  try {
    for(let round=0;round<30;round++) {
      const start=performance.now(); let previous=start, seenText=false, terminal=0;
      const healthStart=performance.now(), health=fetch(url).then(async r => { await r.text();latencies.push(performance.now()-healthStart); });
      for await(const event of parseIMAWebAgentStream(new Response(body))) {
        const now=performance.now();gaps.push(now-previous);previous=now;
        if(event.type==='delta'&&!seenText){first.push(now-start);seenText=true;}
        if(event.type==='done')terminal++;
      }
      if(terminal!==1||!seenText)throw Error('synthetic_stream_invalid');
      await health;peakRSS=Math.max(peakRSS,process.memoryUsage().rss);
    }
    const used=process.cpuUsage(cpu),after=process.resourceUsage();
    return {rounds:30,healthP95Ms:p95(latencies),firstTextP95Ms:p95(first),eventGapP95Ms:p95(gaps),
      eventLoopP95Ms:loop.percentile(95)/1e6,cpuMs:(used.user+used.system)/1000,
      startRSSMiB:startRSS/1048576,peakRSSMiB:peakRSS/1048576,fsWrites:after.fsWrite-resources.fsWrite};
  } finally {loop.disable();server.closeAllConnections();await new Promise(r=>server.close(r));}
}
if(process.argv[2]==='--child') {
  measure(path.resolve(process.argv[3])).then(r=>console.log(JSON.stringify(r))).catch(()=>{console.error('protocol_benchmark_failed');process.exitCode=1;});
} else {
  const baseline=process.argv[2];if(!baseline)throw Error('baseline_protocol_module_required');
  const run=file=>JSON.parse(execFileSync(process.execPath,[__filename,'--child',file],{encoding:'utf8',timeout:60000}));
  const before=run(path.resolve(baseline)),after=run(path.resolve(__dirname,'../src/ima-upstream-protocol.js'));
  const delta={firstTextP95Ms:after.firstTextP95Ms-before.firstTextP95Ms,eventGapP95Ms:after.eventGapP95Ms-before.eventGapP95Ms,
    peakRSSMiB:after.peakRSSMiB-before.peakRSSMiB};
  console.log(JSON.stringify({schemaVersion:1,kind:'synthetic_parser_health_comparison',before,after,delta,
    passed:delta.firstTextP95Ms<=20&&delta.eventGapP95Ms<=20&&delta.peakRSSMiB<=64&&after.healthP95Ms<=250,
    limitations:'Fixed in-memory synthetic streams and loopback health only; no IMA calls, production state, browser, disk persistence or 3DGS load.'},null,2));
}
