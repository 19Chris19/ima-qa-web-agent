(function(global){
  const names={website:'在线问答',provider:'Provider',capacity:'账号容量',persistence:'保存服务'};
  const labels={normal:'正常',degraded:'容量下降',busy:'繁忙',outage:'故障',maintenance:'维护中',unknown:'未知'};
  const time=at=>new Date(at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  function render(root,view){
    if(!root)return;if(!view||view.schema!=='provider_recent_status_v1'){root.textContent='尚无细粒度采样 重启前的记录不会猜补';return;}
    let container=root.querySelector('.recent-rows');if(!container){container=document.createElement('div');container.className='recent-rows';root.replaceChildren(container);}
    for(const [key,name] of Object.entries(names)){
      const data=view.components?.[key];if(!Array.isArray(data)||data.length!==60)continue;
      let row=container.querySelector(`[data-component="${key}"]`);
      if(!row){row=document.createElement('div');row.className='recent-row';row.dataset.component=key;
        const title=document.createElement('div');title.className='recent-row-title';title.textContent=name;const current=document.createElement('span');current.className='recent-current';title.append(current);
        const chart=document.createElement('div');chart.className='recent-chart';const bars=document.createElement('div');bars.className='recent-bars';bars.setAttribute('aria-hidden','true');for(let i=0;i<60;i++)bars.append(document.createElement('span'));
        const range=document.createElement('input');range.type='range';range.min='0';range.max='59';range.step='1';range.value='59';range.className='recent-selector';range.setAttribute('aria-label',`${name}：选择最近 10 分钟内的 10 秒区间`);
        const detail=document.createElement('p');detail.className='recent-detail';detail.setAttribute('role','status');chart.append(bars,range);row.append(title,chart,detail);container.append(row);
        const describe=index=>{const b=row._data?.[index];if(!b)return;row._selectedFrom=b.from;const text=`${time(b.from)}—${time(b.to)} ${labels[b.state]||'未知'} · ${b.samples}/${b.expectedSamples} 次采样${b.coverage<1?' · 部分覆盖或缺失':''}`;detail.textContent=text;range.setAttribute('aria-valuetext',text);};
        range.addEventListener('input',()=>describe(Number(range.value)));range.addEventListener('focus',()=>describe(Number(range.value)));
        chart.addEventListener('pointermove',event=>{if(event.pointerType==='touch')return;const box=chart.getBoundingClientRect();describe(Math.max(0,Math.min(59,Math.floor((event.clientX-box.left)/box.width*60))));});row._describe=describe;
      }
      row._data=data;const current=row.querySelector('.recent-current'),last=data.at(-1);current.textContent=labels[last.state]||'未知';current.dataset.state=last.coverage<1?'unknown':last.state;
      row.querySelectorAll('.recent-bars span').forEach((bar,i)=>{const b=data[i];bar.dataset.state=labels[b.state]?b.state:'unknown';bar.dataset.partial=String(b.coverage<1);bar.title=`${time(b.from)} ${labels[b.state]||'未知'} · ${b.samples}/${b.expectedSamples} 次采样`;});
      const range=row.querySelector('input');if(document.activeElement===range&&Number.isFinite(row._selectedFrom)){const idx=data.findIndex(b=>b.from===row._selectedFrom);range.value=String(Math.max(0,idx));}row._describe(Number(range.value));
    }
    let scale=root.querySelector('.recent-scale');if(!scale){scale=document.createElement('div');scale.className='recent-scale';root.append(scale);}scale.textContent=`${time(view.from)} — 现在 · 灰色或斜纹表示未知 / 部分覆盖`;
  }
  global.RecentStatusView={render};
})(window);
