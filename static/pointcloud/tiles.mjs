import {inferenceSize} from './math.mjs';
const TILE=768;
/** @typedef {{data:Uint8ClampedArray,width:number,height:number}} Pixels */
/** @param {Pixels} pixels @param {number} width @param {number} height @param {{x:number,y:number,width:number,height:number}} [crop] */
export function resizePixels(pixels,width,height,crop={x:0,y:0,width:pixels.width,height:pixels.height}) {
  // Average every source pixel a target pixel covers, so downscaled model input does not alias.
  const data=new Uint8ClampedArray(width*height*4),sx=crop.width/width,sy=crop.height/height,sums=[0,0,0,0];
  for(let y=0;y<height;y++) {
    const y0=Math.min(pixels.height-1,Math.floor(crop.y+y*sy)),y1=Math.min(pixels.height,Math.max(y0+1,Math.floor(crop.y+(y+1)*sy)));
    for(let x=0;x<width;x++) {
      const x0=Math.min(pixels.width-1,Math.floor(crop.x+x*sx)),x1=Math.min(pixels.width,Math.max(x0+1,Math.floor(crop.x+(x+1)*sx)));
      sums.fill(0);
      for(let v=y0;v<y1;v++)for(let u=x0;u<x1;u++){const at=(v*pixels.width+u)*4;for(let c=0;c<4;c++)sums[c]+=pixels.data[at+c];}
      const count=(y1-y0)*(x1-x0),at=(y*width+x)*4;
      for(let c=0;c<4;c++)data[at+c]=sums[c]/count;
    }
  }
  return {data,width,height};
}
/** @param {number} width @param {number} height */
export function depthTiles(width,height) {
  const side=Math.min(width,height),length=Math.max(width,height),horizontal=width>height;
  const count=Math.max(2,Math.ceil((length-side)/(side*.64))+1);
  return Array.from({length:count},(_,i)=>{
    const offset=Math.round((length-side)*i/(count-1));
    return {x:horizontal?offset:0,y:horizontal?0:offset,width:side,height:side};
  });
}
/** Align relative inverse depth using real shared pixels, then feather tile seams.
 * @param {Float32Array} sums @param {Float32Array} weights @param {number} width
 * @param {{x:number,y:number,width:number,height:number}} tile @param {Float32Array} prediction */
export function mergeDepthTile(sums,weights,width,tile,prediction) {
  let n=0,sx=0,sy=0,sxx=0,sxy=0;
  for(let y=0;y<tile.height;y+=2)for(let x=0;x<tile.width;x+=2) {
    const at=(tile.y+y)*width+tile.x+x,value=prediction[y*tile.width+x];
    if(weights[at]&&Number.isFinite(value)) {
      const existing=sums[at]/weights[at];n++;sx+=value;sy+=existing;sxx+=value*value;sxy+=value*existing;
    }
  }
  const variance=n*sxx-sx*sx;
  const gain=n>20&&variance>1e-6?Math.max(.25,Math.min(4,(n*sxy-sx*sy)/variance)):1;
  const offset=n>20?(sy-gain*sx)/n:0;
  for(let y=0;y<tile.height;y++)for(let x=0;x<tile.width;x++) {
    const at=(tile.y+y)*width+tile.x+x,value=prediction[y*tile.width+x];
    if(!Number.isFinite(value))continue;
    const weight=Math.max(.03,Math.min(1,Math.min(x+1,y+1,tile.width-x,tile.height-y)/(tile.width*.12)));
    sums[at]+=(value*gain+offset)*weight;weights[at]+=weight;
  }
}
/** More views retain depth detail: wide captures run overlapping model tiles.
 * @param {Pixels} pixels
 * @param {{estimate:(data:Uint8ClampedArray,width:number,height:number,onProgress:(progress:{phase:string,percent?:number})=>void)=>Promise<{depth:Float32Array,width:number,height:number,model?:string}>}} estimator
 * @param {(progress:{phase:string,percent?:number})=>void} onProgress
 * @param {()=>boolean} current */
export async function estimateImageDepth(pixels,estimator,onProgress,current=()=>true) {
  if(!current())throw new DOMException('Avbrote.','AbortError');
  if(Math.max(pixels.width,pixels.height)/Math.min(pixels.width,pixels.height)<1.6) {
    const size=inferenceSize(pixels.width,pixels.height),input=resizePixels(pixels,size.width,size.height);
    return estimator.estimate(input.data,input.width,input.height,onProgress);
  }
  const scale=Math.min(1,TILE/Math.min(pixels.width,pixels.height),2048/Math.max(pixels.width,pixels.height));
  const input=resizePixels(pixels,Math.round(pixels.width*scale),Math.round(pixels.height*scale));
  const tiles=depthTiles(input.width,input.height),sums=new Float32Array(input.width*input.height),weights=new Float32Array(sums.length);
  let model;
  for(const [i,tile] of tiles.entries()) {
    if(!current())throw new DOMException('Avbrote.','AbortError');
    const size=inferenceSize(tile.width,tile.height,TILE),cropped=resizePixels(input,size.width,size.height,tile);
    const result=await estimator.estimate(cropped.data,size.width,size.height,progress=>onProgress({...progress}));model=result.model;
    const resized=new Float32Array(tile.width*tile.height);
    for(let y=0;y<tile.height;y++)for(let x=0;x<tile.width;x++) {
      resized[y*tile.width+x]=result.depth[Math.min(result.height-1,Math.floor((y+.5)*result.height/tile.height))*result.width+Math.min(result.width-1,Math.floor((x+.5)*result.width/tile.width))];
    }
    mergeDepthTile(sums,weights,input.width,tile,resized);
    onProgress({phase:'estimating',percent:Math.round((i+1)/tiles.length*100)});
  }
  for(let i=0;i<sums.length;i++)sums[i]=weights[i]?sums[i]/weights[i]:NaN;
  return {depth:sums,width:input.width,height:input.height,model};
}
