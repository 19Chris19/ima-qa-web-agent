// Offline acceptance: reject real IMA endpoints. Local fake upstreams remain usable.
const deny = value => { let u;try{u=new URL(typeof value==='string'?value:value?.url||String(value));}catch{return;}if(/(^|\.)(ima\.qq\.com|ima\.tencent\.com|myqcloud\.com)$/i.test(u.hostname))throw Error('real_ima_requests_blocked');};
const original=globalThis.fetch;globalThis.fetch=(u,o)=>{deny(u);return original(u,o);};
for(const name of ['node:http','node:https']){const mod=require(name);for(const method of ['request','get']){const fn=mod[method];mod[method]=function(...args){const v=args[0];if(typeof v==='string'||v instanceof URL)deny(v);else if(v?.hostname)deny('https://'+v.hostname);return fn.apply(this,args);};}
}
