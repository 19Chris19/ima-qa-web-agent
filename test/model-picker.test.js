const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {JSDOM}=require('jsdom');
const script=fs.readFileSync(path.join(__dirname,'../public/model-picker.js'),'utf8');
async function setup(t,{load,web=false}={}){const dom=new JSDOM('<div id="mount"></div><textarea>保留的草稿</textarea>',{runScripts:'outside-only',pretendToBeVisual:true});t.after(()=>dom.window.close());const w=dom.window;w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new w.Event('close'));};w.eval(script);const notices=[];const picker=w.ChatModelPicker.create({mount:w.document.querySelector('#mount'),load:load||(async()=>({enabled:true,defaultSelection:{modelRef:'a'.repeat(64),mode:'quick'},models:[{modelRef:'a'.repeat(64),name:'合成模型 A',modes:{quick:{webSearch:true},deep:{webSearch:false}}},{modelRef:'b'.repeat(64),name:'合成模型 B',modes:{quick:{webSearch:true}}}]})),webRequested:()=>web,notice:t=>notices.push(t)});await picker.refresh();return{w,picker,notices};}
test('model panel switches next send without changing a captured request or draft',async t=>{const{w,picker}=await setup(t);const frozen=picker.capture();picker.button.click();assert.equal(picker.dialog.open,true);picker.dialog.querySelectorAll('.model-picker-option')[1].click();assert.equal(picker.dialog.open,false);assert.equal(picker.capture().mode,'deep');assert.equal(frozen.mode,'quick');assert.equal(w.document.querySelector('textarea').value,'保留的草稿');assert.match(picker.button.textContent,/深度/);});
test('touch and desktop use same explicit open/select/close behavior and restore focus',async t=>{const{w,picker}=await setup(t);picker.button.dispatchEvent(new w.MouseEvent('click',{bubbles:true}));assert.equal(picker.button.getAttribute('aria-expanded'),'true');picker.dialog.querySelector('[aria-label="关闭模型选择"]').click();assert.equal(w.document.activeElement,picker.button);assert.equal(picker.button.getAttribute('aria-expanded'),'false');});
test('web conflict disables unsupported modes without silently changing web choice',async t=>{const{picker}=await setup(t,{web:true});picker.button.click();assert.equal(picker.dialog.querySelectorAll('.model-picker-option')[1].disabled,true);assert.equal(picker.capture().mode,'quick');});
test('late directory response cannot replace another conversation or clear draft',async t=>{
 let resolve;const make=name=>({enabled:true,defaultSelection:{modelRef:'a'.repeat(64),mode:'quick'},models:[{modelRef:'a'.repeat(64),name,modes:{quick:{webSearch:true}}}]});
 const {w,picker}=await setup(t,{load:id=>id==='old'?new Promise(r=>resolve=r):Promise.resolve(make(id||'initial'))});
 const pending=picker.refresh('old');await picker.refresh('new');resolve(make('late old'));await pending;
 assert.match(picker.button.textContent,/new/);assert.doesNotMatch(picker.button.textContent,/late old/);assert.equal(w.document.querySelector('textarea').value,'保留的草稿');
});
test('unavailable directory blocks sends; legacy and disabled kernels retain old behavior',async t=>{const f=await setup(t,{load:async()=>({enabled:true,models:[],reason:'default_not_configured'})});assert.equal(f.picker.capture(),null);assert.match(f.notices.at(-1),/默认模型/);const legacy=await setup(t,{load:async()=>({enabled:true,legacy:true,models:[],reason:'legacy_session'})});assert.equal(legacy.picker.capture(),undefined);const off=await setup(t,{load:async()=>({enabled:false,models:[]})});assert.equal(off.picker.button.hidden,true);assert.equal(off.picker.capture(),undefined);});
test('requested model information is rendered as text with unconfirmed upstream version',async t=>{const{w}=await setup(t);w.ChatModelPicker.renderSelection(w.document.body,{name:'<img src=x onerror=1>',mode:'deep'});assert.equal(w.document.querySelector('details img'),null);assert.match(w.document.querySelector('details').textContent,/未确认/);});

test('compact model list has one mode control, check state and keyboard navigation',async t=>{
 const {w,picker}=await setup(t);picker.button.click();
 const rows=picker.dialog.querySelectorAll('.model-picker-model');assert.equal(rows.length,2);
 assert.equal(picker.dialog.querySelectorAll('.model-picker-option').length,2);
 assert.equal(rows[0].getAttribute('aria-pressed'),'true');assert.equal(w.document.activeElement,rows[0]);
 rows[0].dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));assert.equal(w.document.activeElement,rows[1]);
 rows[1].click();assert.equal(picker.dialog.open,true);assert.equal(picker.capture().modelRef,'b'.repeat(64));
 assert.equal(picker.dialog.querySelectorAll('.model-picker-model[aria-pressed="true"]').length,1);
 assert.equal(picker.dialog.querySelector('[data-mode="deep"]').disabled,true);
});
test('switching from deep to quick-only model requires an explicit valid mode, never silently downgrades',async t=>{
 const {picker,notices}=await setup(t);picker.button.click();picker.dialog.querySelector('[data-mode="deep"]').click();
 picker.button.click();picker.dialog.querySelectorAll('.model-picker-model')[1].click();
 assert.equal(picker.capture(),null);assert.match(notices.at(-1),/可用模型/);
 assert.equal(picker.dialog.querySelector('.model-picker-note').hidden,false);
 picker.dialog.querySelector('[data-mode="quick"]').click();assert.deepEqual(JSON.parse(JSON.stringify(picker.capture())),{modelRef:'b'.repeat(64),mode:'quick'});
});
test('removed selection is not replaced by refreshed default and disabled choices cannot send',async t=>{
 let changed=false;const {picker}=await setup(t,{load:async()=>({enabled:true,defaultSelection:{modelRef:'a'.repeat(64),mode:'quick'},models:changed?[]:[{modelRef:'a'.repeat(64),name:'A',modes:{quick:{webSearch:true}}}]})});
 changed=true;await picker.refresh('',true);assert.equal(picker.capture(),null);
});

test('desktop menu anchors above its trigger and repositions when a model note changes its height',async t=>{
 const {w,picker}=await setup(t);Object.defineProperty(picker.dialog,'offsetHeight',{get:()=>320});Object.defineProperty(picker.dialog,'offsetWidth',{get:()=>320});
 picker.button.getBoundingClientRect=()=>({left:200,top:450,bottom:494});picker.button.click();
 assert.equal(picker.dialog.style.top,'120px');assert.equal(picker.dialog.style.left,'200px');
 picker.button.getBoundingClientRect=()=>({left:210,top:440,bottom:484});w.dispatchEvent(new w.Event('scroll'));
 assert.equal(picker.dialog.style.top,'110px');assert.equal(picker.dialog.style.left,'210px');
});
