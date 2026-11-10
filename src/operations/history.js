'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const STATES = new Set(['normal','busy','degraded','outage','maintenance','unknown']);
const COMPONENTS = ['provider','website','capacity','persistence','private_entry','source_preview'];
const DAY = 86400000;
class StatusHistory {
  constructor({ directory, now = Date.now, maxBytes = 32*1024*1024, days = 30 }) {
    if (!path.isAbsolute(directory || '')) throw Error('absolute_private_directory_required');
    this.directory = directory; this.now = now; this.maxBytes = maxBytes; this.days = days;
    this.pending = Promise.resolve(); this.lastMinute = null; this.lastStates = ''; this.error = false;
  }
  async initialize() {
    await fs.mkdir(this.directory, { recursive:true, mode:0o700 });
    const stat = await fs.lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw Error('history_directory_not_private');
    await this.prune(); return this;
  }
  append(snapshot) {
    const at = this.now(), minute = Math.floor(at/60000);
    const states = Object.fromEntries(COMPONENTS.map(k => [k, STATES.has(snapshot.components?.[k]?.state) ? snapshot.components[k].state : 'unknown']));
    const signature = JSON.stringify(states), entries = [];
    if (this.lastStates && this.lastStates !== signature) entries.push({ kind:'transition', at, states });
    if (minute !== this.lastMinute) entries.push({ kind:'minute', at, states,
      capacity: safeCount(snapshot.capacity), active: safeCount(snapshot.active), queued: safeCount(snapshot.queued),
      qa: safeQA(snapshot.qa) });
    if (!entries.length) return this.pending;
    this.lastMinute = minute; this.lastStates = signature;
    // Bound queued work: collector awaits this promise before scheduling another tick.
    const write = async () => {
      const name = new Date(at).toISOString().slice(0,10)+'.jsonl';
      const filename = path.join(this.directory,name);
      const handle = await fs.open(filename, require('node:fs').constants.O_APPEND | require('node:fs').constants.O_CREAT | require('node:fs').constants.O_WRONLY | require('node:fs').constants.O_NOFOLLOW, 0o600);
      try { await handle.chmod(0o600); await handle.writeFile(entries.map(x=>JSON.stringify(x)+'\n').join('')); }
      finally { await handle.close(); }
      await this.prune(); this.error = false;
    };
    this.pending = this.pending.then(write).catch(()=>{this.error=true;this.lastMinute=null;});
    return this.pending;
  }
  async files() { return (await fs.readdir(this.directory)).filter(x=>/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(x)).sort(); }
  async prune() {
    const files = await this.files(), stats = [];
    for (const file of files) {
      const p = path.join(this.directory,file), s = await fs.lstat(p);
      if (s.isSymbolicLink() || !s.isFile() || (s.mode & 0o077)) throw Error('history_file_not_private');
      if (Date.parse(file.slice(0,10))+DAY <= this.now()-this.days*DAY) { await fs.unlink(p); continue; }
      stats.push({file,size:s.size});
    }
    let bytes = stats.reduce((n,s)=>n+s.size,0);
    while (bytes>this.maxBytes && stats.length) { const s=stats.shift(); await fs.unlink(path.join(this.directory,s.file)); bytes-=s.size; }
    this.bytes=bytes;
  }
  async summary() {
    const end = this.now(), start=end-this.days*DAY;
    const days = Array.from({length:this.days},(_,i)=>({ day:new Date(start+(i+1)*DAY).toISOString().slice(0,10), from:start+i*DAY, to:start+(i+1)*DAY, expectedMinutes:1440, samples:0, states:{}, observedMinutes:0 }));
    const minutes=new Map(); let first=null,last=null; const timeline=[];
    for(const file of await this.files()) {
      const text = await fs.readFile(path.join(this.directory,file),'utf8');
      for(const line of text.split('\n')) {
        let r; try { r=JSON.parse(line); } catch { continue; }
        if(!Number.isFinite(r.at)||r.at<start||r.at>end||!r.states) continue;
        if(r.kind==='transition') { timeline.push({at:r.at,states:cleanStates(r.states)}); if(timeline.length>100)timeline.shift(); continue; }
        if(r.kind!=='minute')continue;
        const d=days[Math.min(this.days-1,Math.floor((r.at-start)/DAY))]; if(!d)continue;
        first=first===null?r.at:Math.min(first,r.at); last=Math.max(last||0,r.at);
        const key=Math.floor(r.at/60000), previous=minutes.get(key);
        if(previous){if(previous.day!==d){previous.day.samples--;previous.day.observedMinutes--;d.samples++;d.observedMinutes++;}for(const k of COMPONENTS){const old=previous.states[k];previous.day.states[k][old]--;}} else { d.samples++;d.observedMinutes++; }
        minutes.set(key,{day:d,states:cleanStates(r.states)});
        for(const k of COMPONENTS) { const s=STATES.has(r.states[k])?r.states[k]:'unknown'; (d.states[k]||={})[s]=(d.states[k][s]||0)+1; }
      }
    }
    return { days, firstObservedAt:first, lastObservedAt:last, timeline:timeline.sort((a,b)=>b.at-a.at), bytes:this.bytes||0, limitBytes:this.maxBytes, storageError:this.error,
      note:'只展示实际采样；未采集时间为未知，不补算正常率' };
  }
}
const safeCount=v=>Number.isSafeInteger(v)&&v>=0?v:null;
function safeQA(q) { return q && typeof q==='object' ? { samples:safeCount(q.samples), successRate:typeof q.successRate==='number'&&q.successRate>=0&&q.successRate<=1?q.successRate:null,
  durationP95Ms:Number.isFinite(q.durationP95Ms)?q.durationP95Ms:null, firstDeltaP95Ms:Number.isFinite(q.firstDeltaP95Ms)?q.firstDeltaP95Ms:null }:null; }
function cleanStates(s) {return Object.fromEntries(COMPONENTS.map(k=>[k,STATES.has(s[k])?s[k]:'unknown']));}
module.exports={StatusHistory,STATES,COMPONENTS};
