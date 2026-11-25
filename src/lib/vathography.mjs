export const VATHOGRAPHY_PRESETS = Object.freeze([
  Object.freeze({id:'band',label:'Lysband'}),
  Object.freeze({id:'mist',label:'Dis'}),
  Object.freeze({id:'abyss',label:'Djup'}),
  Object.freeze({id:'near',label:'Nærlys'}),
  Object.freeze({id:'planes',label:'To plan'}),
]);

const curves = [
  [[0,0],[.25,.005],[.42,.035],[.53,.17],[.66,.96],[.79,.17],[.9,.35],[1,.92]],
  [[0,0],[.2,.015],[.4,.07],[.55,.18],[.7,.48],[.85,.8],[1,.98]],
  [[0,0],[.2,.005],[.4,.06],[.52,.42],[.65,.96],[.78,.28],[.89,.1],[1,.025]],
  [[0,.98],[.2,.965],[.4,.91],[.55,.8],[.7,.5],[.85,.18],[1,0]],
  [[0,.025],[.15,.08],[.3,.98],[.43,.1],[.55,.025],[.68,.15],[.78,.98],[.9,.15],[1,.025]],
];
/** @param {number} value @param {number} low @param {number} high */
const clamp = (value,low,high) => Math.max(low,Math.min(high,value));

/** Inverse depth (larger is nearer) to log depth, 0 near … 1 far, over at most a 20:1 range so sky saturates.
 * @param {ArrayLike<number>} depth */
export function normalizeDepth(depth){
  if(!depth?.length)throw new Error('Ugyldig djupnekart.');
  const positive=[];let finite=0;
  for(let i=0;i<depth.length;i++){const value=depth[i];if(Number.isFinite(value)){finite++;if(value>0)positive.push(value)}}
  if(!finite)throw new Error('Djupnekartet manglar gyldige verdiar.');
  const output=new Float32Array(depth.length);
  const sorted=Float32Array.from(positive).sort(),at=(/** @type {number} */ q)=>sorted[Math.round(q*(sorted.length-1))];
  const near=at(.99),far=Math.max(at(.01),near/20),range=Math.log(near/far);
  if(!sorted.length||!(range>1e-6)){output.fill(.5);return output}
  for(let i=0;i<depth.length;i++){const value=depth[i];output[i]=!Number.isFinite(value)?.5:value>far?clamp(Math.log(near/value)/range,0,1):1}
  return output;
}

/** @param {number[][]} knots */
function pchip(knots){
  const n=knots.length,h=new Float64Array(n-1),delta=new Float64Array(n-1),slopes=new Float64Array(n);
  for(let i=0;i<n-1;i++){h[i]=knots[i+1][0]-knots[i][0];delta[i]=(knots[i+1][1]-knots[i][1])/h[i]}
  for(let i=1;i<n-1;i++)if(delta[i-1]*delta[i]>0){const w1=2*h[i]+h[i-1],w2=h[i]+2*h[i-1];slopes[i]=(w1+w2)/(w1/delta[i-1]+w2/delta[i])}
  /** @param {number} a @param {number} b @param {number} u @param {number} v */
  const endpoint=(a,b,u,v)=>{
    const slope=((2*a+b)*u-a*v)/(a+b);
    return Math.sign(slope)!==Math.sign(u)?0:Math.sign(u)!==Math.sign(v)&&Math.abs(slope)>3*Math.abs(u)?3*u:slope;
  };
  slopes[0]=endpoint(h[0],h[1],delta[0],delta[1]);
  slopes[n-1]=endpoint(h[n-2],h[n-3],delta[n-2],delta[n-3]);
  return (/** @type {number} */ value)=>{
    const x=clamp(value,0,1);let i=0;
    while(i<n-2&&x>knots[i+1][0])i++;
    const t=(x-knots[i][0])/h[i],t2=t*t,t3=t2*t;
    return clamp((2*t3-3*t2+1)*knots[i][1]+(t3-2*t2+t)*h[i]*slopes[i]+(-2*t3+3*t2)*knots[i+1][1]+(t3-t2)*h[i]*slopes[i+1],0,1);
  };
}

const toneLuts=curves.map(knots=>{const evaluate=pchip(knots);return Float32Array.from({length:4097},(_,i)=>evaluate(i/4096)*255)});

/** Render many expressions from one normalized depth field, resampled to the photo.
 * @param {ArrayLike<number>} depth @param {number} width @param {number} height */
export function prepareToneDepth(depth,width,height){
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||depth?.length!==width*height)throw new Error('Ugyldig djupnekart.');
  return ({preset=0,position=0,width:bandWidth=1,contrast=1,gamma=1,outputWidth=width,outputHeight=height}={})=>{
    if(!Number.isInteger(outputWidth)||!Number.isInteger(outputHeight)||outputWidth<1||outputHeight<1||outputWidth*outputHeight>16777216)throw new Error('Ugyldig biletstorleik.');
    const curve=toneLuts[Number.isInteger(preset)&&preset>=0&&preset<toneLuts.length?preset:0];
    const steep=Number.isFinite(contrast)?clamp(contrast,.25,4):1,power=Number.isFinite(gamma)?clamp(gamma,.25,4):1;
    // Midtones (gamma) then contrast around mid-grey, folded into the 4097-step table.
    const lut=steep===1&&power===1?curve:curve.map(value=>clamp(((value/255)**power-.5)*steep+.5,0,1)*255);
    const shift=Number.isFinite(position)?clamp(position,-1,1):0,stretch=Number.isFinite(bandWidth)?clamp(bandWidth,.25,3):1;
    const output=new Uint8ClampedArray(outputWidth*outputHeight*4);
    const valueAt=(/** @type {number} */ index)=>Number.isFinite(depth[index])?depth[index]:.5;
    for(let y=0;y<outputHeight;y++){
      const sy=clamp((y+.5)*height/outputHeight-.5,0,height-1),y0=Math.floor(sy),y1=Math.min(height-1,y0+1),dy=sy-y0;
      for(let x=0;x<outputWidth;x++){
        const sx=clamp((x+.5)*width/outputWidth-.5,0,width-1),x0=Math.floor(sx),x1=Math.min(width-1,x0+1),dx=sx-x0;
        const top=valueAt(y0*width+x0)*(1-dx)+valueAt(y0*width+x1)*dx,bottom=valueAt(y1*width+x0)*(1-dx)+valueAt(y1*width+x1)*dx;
        const index=clamp((top*(1-dy)+bottom*dy-.5-shift)/stretch+.5,0,1)*4096,low=Math.floor(index),high=Math.min(4096,low+1);
        const at=(y*outputWidth+x)*4;
        output[at]=output[at+1]=output[at+2]=lut[low]+(lut[high]-lut[low])*(index-low);output[at+3]=255;
      }
    }
    return output;
  };
}
