/** Tap captures once; a held pointer samples distinct moments until release. */
/** @typedef {{data:Uint8ClampedArray,width:number,height:number}} Frame */
export class FrameRecorder {
  /** @param {{capture:()=>Frame|null,onHold:()=>void,finish:(frames:Frame[])=>void,cancel?:()=>void,limit?:number,delay?:number,interval?:number,now?:()=>number}} options */
  constructor(options) {
    this.options=options; this.active=false;
    /** @type {Frame[]} */ this.frames=[];
    /** @type {ReturnType<typeof setTimeout>|undefined} */ this.timer=undefined;
    this.started=0;
  }
  now() { return this.options.now?.() ?? performance.now(); }
  begin() {
    if(this.active)return;
    this.active=true;this.frames=[];this.started=this.now();
    this.sample();
    this.timer=setTimeout(()=>{
      if(!this.active)return;
      this.options.onHold();
      const loop=()=>{if(!this.active)return;this.sample();this.timer=setTimeout(loop,this.options.interval??250);};
      loop();
    },this.options.delay??320);
  }
  sample() {
    if(this.frames.length >= (this.options.limit??32))return;
    const frame=this.options.capture();
    if(frame)this.frames.push(frame);
  }
  end() {
    if(!this.active)return;
    this.active=false;clearTimeout(this.timer);
    if(this.now()-this.started>=(this.options.delay??320))this.sample();
    const frames=this.frames;this.frames=[];
    this.options.finish(frames);
  }
  abort() {if(!this.active)return;this.active=false;clearTimeout(this.timer);this.frames=[];this.options.cancel?.();}
}
