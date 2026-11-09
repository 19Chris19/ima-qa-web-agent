(function(global){
  function create({mount,load,notice=()=>{},webRequested=()=>false}) {
    const button=document.createElement('button');button.type='button';button.className='model-picker-trigger';button.hidden=true;button.setAttribute('aria-haspopup','dialog');mount.prepend(button);
    const dialog=document.createElement('dialog');dialog.className='model-picker-dialog';dialog.setAttribute('aria-label','模型与思考模式');
    const head=document.createElement('div');head.className='model-picker-head';const title=document.createElement('strong');title.textContent='选择模型';
    const close=document.createElement('button');close.type='button';close.textContent='×';close.setAttribute('aria-label','关闭模型选择');head.append(title,close);
    const body=document.createElement('div');body.className='model-picker-body';const note=document.createElement('p');note.className='model-picker-note';note.setAttribute('aria-live','polite');dialog.append(head,body,note);document.body.append(dialog);
    let data=null,value=null,epoch=0,loading=false,context='',error='',lastChecked=0,placementFrame=0;
    const reasonText={legacy_session:'此会话使用旧版内核，请新建会话选择模型',default_not_configured:'管理员尚未设置默认模型',default_unavailable:'默认模型暂不可用，请选择其他可用模型',policy_unavailable:'模型设置暂不可用',device_context_missing:'账号缺少新版问答所需的设备上下文'};
    const showNotice=text=>{notice(text);note.textContent=text;note.hidden=false;};
    const modes=[['quick','快速'],['deep','深度']];
    function label(text,className){const span=document.createElement('span');span.className=className;span.textContent=text;return span;}
    function selectModel(model){value={modelRef:model.modelRef,mode:value?.mode||'quick'};render();dialog.querySelector(`[data-model-ref="${model.modelRef}"]`)?.focus({preventScroll:true});}
    function render(){button.hidden=!data?.enabled;button.disabled=loading;
      const focused=dialog.contains(document.activeElement)?document.activeElement:null;
      const focusModel=focused?.dataset.modelRef,focusMode=focused?.dataset.mode;
      const m=data?.models?.find(x=>x.modelRef===value?.modelRef);
      button.replaceChildren(label(loading?'读取模型…':m?m.name:data?.legacy?'旧版会话':'选择模型','model-picker-current'));
      if(m)button.append(label(value.mode==='deep'?'深度':'快速','model-picker-current-mode'));
      const chevron=label('','model-picker-chevron');chevron.setAttribute('aria-hidden','true');button.append(chevron);
      button.setAttribute('aria-label',m?`${m.name}，${value.mode==='deep'?'深度':'快速'}，选择模型与思考模式`:button.textContent);
      button.setAttribute('aria-expanded',String(dialog.open));body.replaceChildren();
      const list=document.createElement('div');list.className='model-picker-list';list.setAttribute('role','group');list.setAttribute('aria-label','可用模型');
      for(const model of data?.models||[]){
        const option=document.createElement('button');option.type='button';option.className='model-picker-model';option.dataset.modelRef=model.modelRef;
        const selected=value?.modelRef===model.modelRef;option.setAttribute('aria-pressed',String(selected));
        option.append(label(model.name,'model-picker-name'));
        const check=label('','model-picker-check');check.setAttribute('aria-hidden','true');option.append(check);
        option.disabled=webRequested()&&!Object.values(model.modes).some(info=>info.webSearch);
        if(option.disabled)option.title='此模型不支持当前联网选择';
        option.addEventListener('click',()=>selectModel(model));list.append(option);
      }
      body.append(list);
      if(m){const section=document.createElement('div');section.className='model-picker-mode-row';
        section.append(label('思考模式','model-picker-mode-label'));
        const group=document.createElement('div');group.className='model-picker-modes';group.setAttribute('role','group');group.setAttribute('aria-label','思考模式');
        for(const [mode,name] of modes){const info=m.modes[mode];const option=document.createElement('button');option.type='button';option.className='model-picker-option';option.dataset.mode=mode;option.textContent=name;
          option.setAttribute('aria-pressed',String(value.mode===mode));option.disabled=!info||(webRequested()&&!info.webSearch);
          if(option.disabled)option.title=!info?'此模型暂不支持'+name:'此模式不支持当前联网选择';
          option.addEventListener('click',()=>{value={modelRef:m.modelRef,mode};render();dialog.close();});group.append(option);}
        section.append(group);body.append(section);
      }
      const info=m?.modes[value?.mode];
      note.textContent=error||reasonText[data?.reason]||(m&&!info?'请选择此模型支持的思考模式':m&&webRequested()&&!info?.webSearch?'当前模式不支持联网，请调整选择':'');
      note.hidden=!note.textContent;
      if(focusModel)list.querySelector(`[data-model-ref="${focusModel}"]`)?.focus({preventScroll:true});
      else if(focusMode)body.querySelector(`[data-mode="${focusMode}"]`)?.focus({preventScroll:true});
      place();
    }
    // Arrow keys move within each choice group; Enter/Space confirms the focused choice.
    body.addEventListener('keydown',e=>{if(!['ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;
      const group=e.target.closest('[role="group"]');if(!group)return;
      const choices=[...group.querySelectorAll('button:not(:disabled)')],index=choices.indexOf(e.target);if(index<0)return;e.preventDefault();
      const next=e.key==='Home'?0:e.key==='End'?choices.length-1:(index+(['ArrowUp','ArrowLeft'].includes(e.key)?-1:1)+choices.length)%choices.length;
      choices[next]?.focus();
    });
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
    function place(){
      if(!dialog.open)return;
      if(global.matchMedia?.('(max-width: 640px), (hover: none)')?.matches){
        for(const key of ['top','left','margin','position'])dialog.style.removeProperty(key);
        return;
      }
      const r=button.getBoundingClientRect();dialog.style.position='fixed';dialog.style.margin='0';
      dialog.style.left=Math.max(16,Math.min(r.left,innerWidth-dialog.offsetWidth-16))+'px';
      const above=r.top-dialog.offsetHeight-10,below=r.bottom+10;
      dialog.style.top=Math.max(12,Math.min(above>=12?above:below,innerHeight-dialog.offsetHeight-12))+'px';
    }
    function followMovingAnchor(){
      place();
      // Follow an existing composer transition, then stop measuring when it settles.
      const moving=document.getAnimations?.().some(a=>a.playState==='running'&&a.effect?.target?.contains?.(button));
      if(dialog.open&&moving)placementFrame=requestAnimationFrame(followMovingAnchor);
    }
    button.addEventListener('click',()=>{render();dialog.showModal();if(Date.now()-lastChecked>=300000)void refresh(context,true);
      place();placementFrame=requestAnimationFrame(followMovingAnchor);button.setAttribute('aria-expanded','true');
      (body.querySelector('.model-picker-model[aria-pressed="true"]:not(:disabled)')||body.querySelector('.model-picker-model:not(:disabled)')||close).focus({preventScroll:true});});
    close.addEventListener('click',()=>dialog.close());dialog.addEventListener('close',()=>{cancelAnimationFrame(placementFrame);button.setAttribute('aria-expanded','false');button.focus({preventScroll:true});});
    global.addEventListener('scroll',place,true);
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
