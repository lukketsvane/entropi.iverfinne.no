/** Genuine XYZ projection for browsers without a WebGL2 context. */
import {HeadParallax} from './head-parallax.mjs';
import {attachViewerGestures, noAdjust, progressiveIndices} from './viewer-gestures.ts';
import {nearestC64} from './c64-palette.ts';
/** @typedef {ReturnType<typeof import('../../../static/pointcloud/math.mjs').imageToPointCloud>} PointCloud */
export class CanvasPointCloudViewer {
  /** @param {HTMLElement} host @param {PointCloud} cloud */
  constructor(host,cloud,onAdjust = noAdjust) {
    this.host=host;this.cloud=cloud;this.canvas=document.createElement('canvas');
    const context=this.canvas.getContext('2d',{alpha:true});
    if(!context)throw new Error('Kunne ikkje vise punktskyen.');
    this.context=context;host.replaceChildren(this.canvas);this.canvas.style.touchAction='none';
    this.disposed=false;this.dirty=true;this.auto=true;this.yaw=.16;this.pitch=.045;this.zoom=1;this.panX=0;this.panY=0;this.pointSize=1;this.definition=.5;
    this.style='mono';
    this.parallax=new HeadParallax();
    this.reducedMotion=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    this.auto=!this.reducedMotion;
    /** @type {Map<number,{x:number,y:number}>} */ this.pointers=new Map();
    const stride=Math.max(1,Math.ceil(cloud.count/21000));
    const baseIndices=Array.from({length:Math.ceil(cloud.count/stride)},(_,i)=>i*stride);
    this.indices=progressiveIndices(baseIndices.length).map(i=>baseIndices[i]);
    this.paletteColors=new Uint8Array(this.indices.length*3);
    for(let i=0;i<this.indices.length;i++){
      const source=this.indices[i]*3;
      const color=nearestC64(cloud.colors[source],cloud.colors[source+1],cloud.colors[source+2]);
      this.paletteColors.set(color,i*3);
    }
    this.projected=new Float32Array(this.indices.length*3);
    this.order=this.indices.map((_,i)=>i);
    this.gestures=attachViewerGestures(this.canvas,{
      onDensity:value=>{this.order=Array.from({length:Math.max(1,Math.round(this.indices.length*value))},(_,i)=>i);this.dirty=true;},
      onDefinition:value=>{this.definition=value;this.setPointSize(4**(1-2*value));},
      onRotate:(x,y)=>{this.yaw+=x*.006;this.pitch=Math.max(-1.4,Math.min(1.4,this.pitch+y*.006));this.dirty=true;},
      onTransform:(x,y,scale,focusX,focusY)=>{
        const next=Math.max(.005,Math.min(4,this.zoom*scale)),ratio=next/this.zoom;
        this.panX+=x+(1-ratio)*(focusX-this.canvas.clientWidth/2-this.panX);
        this.panY+=y+(1-ratio)*(focusY-this.canvas.clientHeight/2-this.panY);
        this.zoom=next;this.dirty=true;
      },
      onTouch:active=>{
        this.touching=active;this.auto=false;
        if(active){this.parallax.position.set(0,0,0);this.parallax.setPose(null);}
        else this.parallax.setPose(this.lastPose||null);
        this.dirty=true;
      },
      onAdjust
    });
    this.resize=()=>{
      this.canvas.width=Math.max(1,Math.round(host.clientWidth));this.canvas.height=Math.max(1,Math.round(host.clientHeight));this.dirty=true;
    };
    this.resize();this.observer=new ResizeObserver(this.resize);this.observer.observe(host);
    /** @param {PointerEvent} e */
    this.down=e=>{this.auto=false;this.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});this.canvas.setPointerCapture(e.pointerId);};
    /** @param {PointerEvent} e */
    this.move=e=>{
      const previous=this.pointers.get(e.pointerId);if(!previous)return;
      const before=[...this.pointers.values()];this.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
      if(this.pointers.size===1){this.yaw+=(e.clientX-previous.x)*.006;this.pitch=Math.max(-1.4,Math.min(1.4,this.pitch+(e.clientY-previous.y)*.006));}
      else {
        const after=[...this.pointers.values()],old=Math.hypot(before[0].x-before[1].x,before[0].y-before[1].y),next=Math.hypot(after[0].x-after[1].x,after[0].y-after[1].y);
        if(old>1)this.zoom=Math.max(.005,Math.min(4,this.zoom*next/old));
        this.panX+=((after[0].x+after[1].x)-(before[0].x+before[1].x))*.5;
        this.panY+=((after[0].y+after[1].y)-(before[0].y+before[1].y))*.5;
      }
      this.dirty=true;e.preventDefault();
    };
    /** @param {PointerEvent} e */ this.up=e=>{this.pointers.delete(e.pointerId);};
    /** @param {WheelEvent} e */ this.wheel=e=>{this.auto=false;this.zoom=Math.max(.005,Math.min(4,this.zoom*Math.exp(-e.deltaY*.001)));this.dirty=true;e.preventDefault();};
    this.canvas.addEventListener('pointerdown',this.down);this.canvas.addEventListener('pointermove',this.move);
    this.canvas.addEventListener('pointerup',this.up);this.canvas.addEventListener('pointercancel',this.up);
    this.canvas.addEventListener('wheel',this.wheel,{passive:false});
    this.animation=0;let previous=0;
    /** @param {number} time */
    const frame=time=>{
      if(this.disposed)return;this.animation=requestAnimationFrame(frame);
      if(document.hidden||time-previous<65)return;
      previous=time;if(this.auto){this.yaw+=.003;this.dirty=true;}
      if(this.dirty||this.parallax.moving){this.render(time);this.dirty=false;}
    };
    this.animation=requestAnimationFrame(frame);
  }
  /** @param {number} [time] */
  render(time=performance.now()) {
    const {width,height}=this.canvas,ctx=this.context,positions=this.cloud.positions,colors=this.cloud.colors;
    const cy=Math.cos(this.yaw),sy=Math.sin(this.yaw),cp=Math.cos(this.pitch),sp=Math.sin(this.pitch);
    const radius=Math.max(.01,this.cloud.radius),distance=radius*2.8/this.zoom,focal=Math.min(width,height)*1.08;
    const eye=this.parallax.offsets(distance,width/height,time,this.reducedMotion);
    ctx.clearRect(0,0,width,height);
    ctx.globalAlpha=Math.min(1,.6+.8*this.definition);
    for(let i=0;i<this.order.length;i++) {
      const at=this.indices[i]*3,x=positions[at],y=positions[at+1],z=positions[at+2];
      const rx=x*cy+z*sy,rz=-x*sy+z*cy,ry=y*cp-rz*sp,depth=distance+eye.z-(y*sp+rz*cp);
      this.projected[i*3]=width/2+this.panX+focal*(eye.scale*(rx-eye.x)/depth+eye.x/eye.screen);
      this.projected[i*3+1]=height/2+this.panY-focal*(eye.scale*(ry-eye.y)/depth+eye.y/eye.screen);this.projected[i*3+2]=depth;
    }
    this.order.sort((a,b)=>this.projected[b*3+2]-this.projected[a*3+2]);
    for(const i of this.order) {
      const x=this.projected[i*3],y=this.projected[i*3+1],depth=this.projected[i*3+2];
      if(depth<.01||x<0||x>width||y<0||y>height)continue;
      const at=this.indices[i]*3;
      if(this.style==='crt') {
        // Same limited RGB phosphor palette as the WebGL renderer.
        const seed=positions[at]*127.1+positions[at+1]*311.7+positions[at+2]*74.7;
        const raw=Math.sin(seed)*43758.5453;
        const threshold=.22+(raw-Math.floor(raw))*.56;
        const phosphor=[0,1,2].map(c=>Math.pow(colors[at+c]/255,.67)>=threshold?255:0);
        ctx.fillStyle=`rgb(${phosphor[0]},${Math.round(phosphor[1]*.94)},${phosphor[2]})`;
      }
      else if(this.style==='color'){
        const c=i*3;
        ctx.fillStyle=`rgb(${this.paletteColors[c]},${this.paletteColors[c+1]},${this.paletteColors[c+2]})`;
      }
      else {const gray=Math.round(92+(colors[at]*.299+colors[at+1]*.587+colors[at+2]*.114)*.64);ctx.fillStyle=`rgb(${gray},${gray},${gray})`;}
      const size=Math.max(.25,Math.min(24,radius*.0087*focal/depth*this.pointSize));ctx.fillRect(x-size/2,y-size/2,size,size);
    }
    ctx.globalAlpha=1;
  }
  /** @param {import('./head-parallax.mjs').HeadPose|null} pose */
  setHeadPose(pose){this.lastPose=pose;if(!this.touching)this.parallax.setPose(pose);if(pose)this.auto=false;this.dirty=true;}
  /** @param {'color'|'silver'|'depth'|'mono'|'crt'} style */ setStyle(style){this.style=style;this.dirty=true;}
  /** @param {number} size */ setPointSize(size){this.pointSize=size;this.dirty=true;}
  reset(){this.yaw=.16;this.pitch=.045;this.zoom=1;this.panX=0;this.panY=0;this.dirty=true;}
  /** Monochrome copy for the printer, preserving the on-screen colour treatment. */
  snapshot(){
    const canvas=document.createElement('canvas');canvas.width=384;
    canvas.height=Math.max(1,Math.min(1024,Math.round(384*this.canvas.height/this.canvas.width)));
    const context=canvas.getContext('2d');if(!context)throw new Error('Kunne ikkje lese punktskyen.');
    const style=this.style;
    try{this.style='mono';this.render();context.fillStyle='#000';context.fillRect(0,0,canvas.width,canvas.height);context.filter=this.gestures.state.filter;context.drawImage(this.canvas,0,0,canvas.width,canvas.height);}
    finally{this.style=style;this.render();this.dirty=true;}
    return canvas;
  }
  dispose(){
    if(this.disposed)return;this.disposed=true;cancelAnimationFrame(this.animation);this.observer.disconnect();this.pointers.clear();this.gestures.dispose();
    this.canvas.removeEventListener('pointerdown',this.down);this.canvas.removeEventListener('pointermove',this.move);
    this.canvas.removeEventListener('pointerup',this.up);this.canvas.removeEventListener('pointercancel',this.up);this.canvas.removeEventListener('wheel',this.wheel);this.canvas.remove();
  }
}
