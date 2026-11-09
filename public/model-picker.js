(function(global){
  function create({mount,load,notice=()=>{},webRequested=()=>false}) {
    const button=document.createElement('button');button.type='button';button.className='model-picker-trigger';button.hidden=true;button.setAttribute('aria-haspopup','dialog');mount.prepend(button);
    const dialog=document.createElement('dialog');dialog.className='model-picker-dialog';dialog.setAttribute('aria-label','模型与思考模式');
    const head=document.createElement('div');head.className='model-picker-head';const title=document.createElement('strong');title.textContent='模型与思考模式';
    const close=document.createElement('button');close.type='button';close.textContent='×';close.setAttribute('aria-label','关闭模型选择');head.append(title,close);
    const body=document.createElement('div');body.className='model-picker-body';const note=document.createElement('p');note.className='model-picker-note';note.textContent='选择用于下一次发送';dialog.append(head,body,note);document.body.append(dialog);
    let data=null,value=null,epoch=0,loading=false,context='',error='',lastChecked=0;
    const reasonText={legacy_session:'此会话使用旧版内核，请新建会话选择模型',default_not_configured:'管理员尚未设置默认模型',default_unavailable:'默认模型暂不可用，请选择其他可用模型',policy_unavailable:'模型设置暂不可用',device_context_missing:'账号缺少新版问答所需的设备上下文'};
    const showNotice=text=>{notice(text);note.textContent=text;};
    function render(){button.hidden=!data?.enabled;button.disabled=loading;
      const m=data?.models?.find(x=>x.modelRef===value?.modelRef);
      button.textContent=loading?'读取模型…':m?`${m.name} · ${value.mode==='deep'?'深度':'快速'}`:data?.legacy?'旧版会话':'选择模型';
      button.setAttribute('aria-expanded',String(dialog.open));body.replaceChildren();
      for(const model of data?.models||[]){const group=document.createElement('fieldset');const legend=document.createElement('legend');legend.textContent=model.name;group.append(legend);
        for(const [mode,info]of Object.entries(model.modes)){const option=document.createElement('button');option.type='button';option.className='model-picker-option';option.textContent=mode==='deep'?'深度':'快速';
          option.setAttribute('aria-pressed',String(value?.modelRef===model.modelRef&&value.mode===mode));option.disabled=webRequested()&&!info.webSearch;
          if(option.disabled)option.title='此模式不支持当前联网选择';option.addEventListener('click',()=>{value={modelRef:model.modelRef,mode};render();dialog.close();});group.append(option);}
        body.append(group);}
      note.textContent=error||reasonText[data?.reason]||'选择用于下一次发送';
    }
    async function refresh(conversationId='',keepSelection=false){
      const same=keepSelection||context===conversationId;context=conversationId;const current=++epoch;loading=true;render();
      try{const next=await load(conversationId);if(current!==epoch)return;data=next;error='';lastChecked=Date.now();
        const previous=same&&value;value=previous?previous:next.defaultSelection?{...next.defaultSelection}:null;
      }catch{if(current!==epoch)return;error='模型目录暂不可用，请稍后再试';data={enabled:true,models:[]};value=null;}
      finally{if(current===epoch){loading=false;render();}}
    }
    function capture(){if(!data||loading){showNotice('正在核对模型，请稍后发送');return null;}if(!data.enabled||data.legacy)return undefined;
      const m=data.models?.find(x=>x.modelRef===value?.modelRef),info=m?.modes[value?.mode];
      if(!info){showNotice(error||reasonText[data.reason]||'请选择可用模型');return null;}
      if(webRequested()&&!info.webSearch){showNotice('当前模型模式不支持联网，请调整选择');return null;}
      return {...value};}
    button.addEventListener('click',()=>{render();dialog.showModal();if(Date.now()-lastChecked>=300000)void refresh(context,true);if(!global.matchMedia?.('(max-width: 640px), (hover: none)')?.matches){const r=button.getBoundingClientRect();dialog.style.position='fixed';dialog.style.margin='0';dialog.style.left=Math.max(16,Math.min(r.left,innerWidth-dialog.offsetWidth-16))+'px';dialog.style.top=Math.max(12,r.top-dialog.offsetHeight-12)+'px';}else{dialog.style.removeProperty('top');dialog.style.removeProperty('left');dialog.style.removeProperty('margin');}button.setAttribute('aria-expanded','true');close.focus();});
    close.addEventListener('click',()=>dialog.close());dialog.addEventListener('close',()=>{button.setAttribute('aria-expanded','false');button.focus({preventScroll:true});});
    dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});
    global.addEventListener('resize',()=>{if(dialog.open)dialog.close();});
    return {refresh,capture,render,button,dialog};
  }
  function renderSelection(target,value){
    if(!value||!['quick','deep'].includes(value.mode)||typeof value.name!=='string')return;
    let node=target.querySelector('.model-answer-selection');if(!node){node=document.createElement('details');node.className='model-answer-selection';target.append(node);}
    node.replaceChildren();const summary=document.createElement('summary');summary.textContent=value.name+' · '+(value.mode==='deep'?'深度':'快速');
    const text=document.createElement('span');text.textContent='本轮请求配置；上游模型版本未确认';node.append(summary,text);
  }
  global.ChatModelPicker={create,renderSelection};
})(globalThis);
