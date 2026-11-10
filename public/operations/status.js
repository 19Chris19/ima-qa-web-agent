(function(){
  const labels={normal:'正常',busy:'繁忙',degraded:'部分降级',outage:'不可用',maintenance:'维护中',unknown:'未知'};
  const names={provider:'Provider 与任务队列',website:'网站与 BFF',capacity:'账号服务容量',persistence:'持久化服务',private_entry:'既有私网入口',source_preview:'网页封面（可选）'};
  const components=document.querySelector('#components');
  for(const [key,name] of Object.entries(names)){const row=document.createElement('div');row.className='component';const label=document.createElement('span');label.textContent=name;const value=document.createElement('span');value.id=`component-${key}`;value.className='state unknown';value.textContent='未知';row.append(label,value);components.append(row);}
  let last=null,historyKey='';
  function badge(el,state){el.className=`state ${state in labels?state:'unknown'}`;el.textContent=labels[state]||'未知';}
  function render(v){
    document.querySelector('#synthetic').hidden = v.synthetic !== true;
    window.RecentStatusView?.render(document.querySelector('#recentStatus'),v.recent);
    document.querySelector('.hero').dataset.state=v.state;
    last=v;document.body.classList.remove('stale');badge(document.querySelector('#state'),v.state);
    document.querySelector('#headline').textContent={normal:'当前服务运行正常',busy:'服务繁忙，问题正在排队',degraded:'服务可用，部分容量需要维护',outage:'部分核心服务暂不可用',maintenance:'正在维护，暂缓新任务',unknown:'当前服务状态尚不能确认'}[v.state]||'状态未知';
    document.querySelector('#stamp').textContent=`更新于 ${new Date(v.observedAt).toLocaleTimeString('zh-CN')} · 运行快照 15 秒后过期`;
    for(const k of ['ready','capacity','active','queued'])document.querySelector(`#${k}`).textContent=v[k]??'—';
    for(const k of Object.keys(names))badge(document.querySelector(`#component-${k}`),v.components[k]?.state||'unknown');
    document.querySelector('#qa').textContent=v.qa?.samples?`最近一小时（最多 512 个）${v.qa.samples} 个样本 · 成功率 ${(v.qa.successRate*100).toFixed(1)}% · 完成 P95 ${v.qa.durationP95Ms??'—'} ms · 首段 P95 ${v.qa.firstDeltaP95Ms??'—'} ms`:'没有真实样本，不计算成功率或回答延迟';
    document.querySelector('#storage').textContent=v.history?.storageError?'历史记录暂时无法保存；当前状态仍单独展示':'';
    const nextKey=JSON.stringify(v.history);
    if(nextKey!==historyKey&&!document.querySelector('#history').contains(document.activeElement)){historyKey=nextKey;renderHistory(v.history);}
  }
  function renderHistory(h){
    const root=document.querySelector('#history');root.replaceChildren();
    const detail=document.createElement('p');detail.className='history-detail';detail.setAttribute('role','status');detail.textContent='点按或聚焦日期，查看实际采样覆盖';
    for(const [key,name] of Object.entries(names)){
      const row=document.createElement('div');row.className='history-row';const title=document.createElement('strong');title.textContent=name;const bars=document.createElement('div');bars.className='bars';bars.setAttribute('aria-hidden','true');const selector=document.createElement('select');selector.className='history-selector';selector.setAttribute('aria-label',`${name}：选择采样日期`);
      for(const day of h?.days||[]){
        const counts=day.states?.[key]||{},total=Object.values(counts).reduce((n,x)=>n+x,0);
        // Only sampled minutes receive color; unobserved remainder stays gray.
        const dayStart=Date.parse(day.day),elapsed=Math.max(0,Math.min(1440,Math.ceil((Date.now()-dayStart)/60000)));
        const span=day.expectedMinutes||Math.max(1,elapsed),coverage=Math.min(1,total/span);
        let pos=0;const stops=[];
        for(const state of ['outage','maintenance','unknown','degraded','busy','normal']){const n=counts[state]||0;if(!n)continue;const end=pos+n/span*100;stops.push(`var(--${state}) ${pos}% ${end}%`);pos=end;}
        stops.push(`var(--unknown) ${Math.min(100,pos)}% 100%`);
        const button=document.createElement('span');button.className='bar';const image=document.createElement('span');image.style.background=`linear-gradient(to top, ${stops.join(',')})`;button.append(image);
        const text=`${new Date(day.from||dayStart).toLocaleString('zh-CN')} 至 ${new Date(day.to||dayStart+86400000).toLocaleString('zh-CN')} · ${name}：实际 ${total} 分钟；覆盖 ${(coverage*100).toFixed(1)}%；${Object.entries(counts).map(([s,n])=>`${labels[s]||'未知'} ${n} 分钟`).join('，')||'尚未采集'}`;
        button.title=text;button.addEventListener('mouseenter',()=>{detail.textContent=text;});bars.append(button);const option=document.createElement('option');option.value=text;option.textContent=`${day.day} · 采样 ${total} 分钟`;selector.append(option);
      }selector.selectedIndex=Math.max(0,selector.options.length-1);selector.addEventListener('change',()=>{detail.textContent=selector.value;});selector.addEventListener('focus',()=>{detail.textContent=selector.value;});row.append(title,bars,selector);root.append(row);
    }root.append(detail);
    document.querySelector('#coverage').textContent=h?.firstObservedAt?`首次采样 ${new Date(h.firstObservedAt).toLocaleString('zh-CN')} · 历史占用 ${((h.bytes||0)/1024).toFixed(1)} KiB / 32 MiB`:'尚无历史采样；不会补造之前的正常记录';
    const timeline=document.querySelector('#timeline');timeline.replaceChildren();
    for(const item of (h?.timeline||[]).slice(0,20)){const row=document.createElement('div');row.className='timeline-item';const time=document.createElement('time');time.textContent=new Date(item.at).toLocaleString('zh-CN');const p=document.createElement('p');p.textContent=Object.entries(item.states).map(([k,s])=>`${names[k]}：${labels[s]}`).join(' · ');row.append(time,p);timeline.append(row);}
    if(!timeline.childElementCount)timeline.textContent='暂无已记录的状态变化';
  }
  const poller=new AdminPoller({read:async signal=>{const r=await fetch('/api/status',{signal,cache:'no-store'});if(!r.ok)throw Error('status_unavailable');return r.json();},accept:render,fail:()=>{document.querySelector('#stamp').textContent='暂时无法更新；过期后显示未知';}});
  void poller.start();document.addEventListener('visibilitychange',()=>{if(!document.hidden)void poller.refresh();});
  let timer;const checkStaleness=()=>{if(last&&Date.now()-last.observedAt>15000){document.body.classList.add('stale');document.querySelector('.hero').dataset.state='unknown';badge(document.querySelector('#state'),'unknown');document.querySelector('#headline').textContent='状态快照已过期';for(const k of Object.keys(names))badge(document.querySelector(`#component-${k}`),'unknown');for(const k of ['ready','capacity','active','queued'])document.querySelector(`#${k}`).textContent='—';}};timer=setInterval(checkStaleness,1000);
  window.addEventListener('pageshow',event=>{if(event.persisted){void poller.start();timer=setInterval(checkStaleness,1000);}});
  window.addEventListener('pagehide',()=>{poller.close();clearInterval(timer);});
})();
