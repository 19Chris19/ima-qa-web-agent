/* One refresh at a time, hidden-tab pause, bounded backoff, abort on close. */
(function(root){
  class AdminPoller {
    constructor({read,accept,fail=()=>{},visible=()=>!document.hidden,interval=5000,now=Date.now,schedule=(fn,ms)=>setTimeout(fn,ms),cancel=id=>clearTimeout(id)}){
      Object.assign(this,{read,accept,fail,visible,interval,now,schedule,cancel});this.closed=false;this.errors=0;this.sequence=0;
    }
    start(){this.closed=false;return this.refresh();}
    async refresh(){
      if(this.closed||this.inflight)return;this.cancel(this.timer);
      if(!this.visible()){this.timer=this.schedule(()=>this.refresh(),this.interval);return;}
      this.inflight=true;const sequence=++this.sequence;this.controller=new AbortController();
      const timeout=this.schedule(()=>this.controller.abort(),4000);
      try{const value=await this.read(this.controller.signal);if(!this.closed&&sequence===this.sequence){this.accept(value);this.errors=0;}}
      catch(error){if(!this.closed){this.errors++;this.fail(error);}}
      finally{this.cancel(timeout);this.inflight=false;if(!this.closed)this.timer=this.schedule(()=>this.refresh(),Math.min(60000,this.interval*2**Math.min(this.errors,4)));}
    }
    close(){this.closed=true;this.sequence++;this.cancel(this.timer);this.controller?.abort();}
  }
  root.AdminPoller=AdminPoller;if(typeof module!=='undefined')module.exports={AdminPoller};
})(typeof window!=='undefined'?window:globalThis);
