/**
 * Browser-only panorama registration and feather compositing.
 * Multiple real video frames are aligned into a 2D panorama.
 * Depth is inferred separately; no fabricated multi-view geometry.
 */

/** @typedef {{width:number,height:number,rgba:Uint8ClampedArray}} Frame */

/** @param {Frame} frame @param {number} [maxWidth] */
export function thumbnail(frame, maxWidth = 84) {
  const width = Math.min(maxWidth, frame.width);
  const height = Math.max(12, Math.round(frame.height * width / frame.width));
  const values = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const sy0 = Math.floor(y * frame.height / height);
    const sy1 = Math.max(sy0 + 1, Math.ceil((y+1) * frame.height / height));
    for (let x = 0; x < width; x++) {
      const sx0 = Math.floor(x * frame.width / width);
      const sx1 = Math.max(sx0 + 1, Math.ceil((x+1) * frame.width / width));
      let sum = 0, count = 0;
      for (let sy = sy0; sy < Math.min(frame.height,sy1); sy++)
        for (let sx = sx0; sx < Math.min(frame.width,sx1); sx++) {
          const i = (sy * frame.width + sx) * 4;
          sum += frame.rgba[i] * 0.299 + frame.rgba[i+1] * 0.587 + frame.rgba[i+2] * 0.114;
          count++;
        }
      values[y * width + x] = Math.round(sum / count);
    }
  }
  return { width, height, values };
}

/** @param {{width:number,height:number,values:Uint8Array}} a @param {{width:number,height:number,values:Uint8Array}} b */
export function estimateTranslation(a, b) {
  if (a.width !== b.width || a.height !== b.height) throw new Error('Frames have different sizes');
  const w = a.width, h = a.height;
  const maxDx = Math.max(2, Math.floor(w * 0.38));
  const maxDy = Math.max(2, Math.floor(h * 0.28));
  const errorAt = (dx, dy) => {
    const x0 = Math.max(0, dx), x1 = Math.min(w, w + dx);
    const y0 = Math.max(0, dy), y1 = Math.min(h, h + dy);
    const overlap = (x1-x0)*(y1-y0)/(w*h);
    if (overlap < 0.46) return Infinity;
    let error = 0, samples = 0;
    for (let y = y0+1; y < y1-1; y += 2) {
      const ay = y*w, by = (y-dy)*w;
      for (let x = x0+1; x < x1-1; x += 2) {
        const i = ay+x, j = by+x-dx;
        // Edges are useful for matching; ignore near-featureless pixels.
        const gradient = Math.abs(a.values[i]-a.values[i-1]) +
          Math.abs(a.values[i]-a.values[i-w]);
        if (gradient < 9) continue;
        error += Math.abs(a.values[i]-b.values[j]);
        samples++;
      }
    }
    if (samples < 20) return Infinity;
    return error / samples + (1-overlap)*7 + (Math.abs(dx)/w + Math.abs(dy)/h)*1.3;
  };
  const baseline = errorAt(0, 0);
  if (!Number.isFinite(baseline)) return null;
  let best = {dx:0,dy:0,score:baseline};
  for (let dy = -maxDy; dy <= maxDy; dy += 3) {
    for (let dx = -maxDx; dx <= maxDx; dx += 3) {
      const score = errorAt(dx,dy);
      if (score < best.score) best = {dx,dy,score};
    }
  }
  const rough = best;
  for (let dy = Math.max(-maxDy,rough.dy-3); dy <= Math.min(maxDy,rough.dy+3); dy++) {
    for (let dx = Math.max(-maxDx,rough.dx-3); dx <= Math.min(maxDx,rough.dx+3); dx++) {
      const score = errorAt(dx,dy);
      if (score < best.score) best = {dx,dy,score};
    }
  }
  if (best.score > 45 || baseline - best.score < 1.5 ||
      (Math.abs(best.dx) < 2 && Math.abs(best.dy) < 2)) return null;
  return {...best, improvement:baseline-best.score};
}

/** @param {Frame[]} frames @param {{maxWidth?:number,maxHeight?:number,maxPixels?:number}} [options] */
export function stitchFrames(frames, options = {}) {
  if (!Array.isArray(frames) || frames.length < 1 || frames.length > 36) throw new Error('Invalid frame sequence');
  const first = frames[0], w = first.width, h = first.height;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 24 || h < 24 || w*h > 600000) throw new Error('Invalid frame dimensions');
  for (const frame of frames) {
    if (frame.width !== w || frame.height !== h || !(frame.rgba instanceof Uint8ClampedArray) ||
        frame.rgba.length !== w*h*4) throw new Error('Invalid frame pixels');
  }
  const accepted = [{frame:first,x:0,y:0}];
  let last = thumbnail(first), x=0, y=0;
  for (let i=1;i<frames.length;i++) {
    const current = thumbnail(frames[i]);
    const shift = estimateTranslation(last,current);
    if (!shift) continue;
    x += shift.dx*w/current.width;
    y += shift.dy*h/current.height;
    accepted.push({frame:frames[i],x,y});
    last = current;
  }
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for (const item of accepted) {
    minX=Math.min(minX,item.x);minY=Math.min(minY,item.y);
    maxX=Math.max(maxX,item.x+w);maxY=Math.max(maxY,item.y+h);
  }
  const fullWidth=Math.ceil(maxX-minX),fullHeight=Math.ceil(maxY-minY);
  const maxWidth=options.maxWidth ?? 3072, maxHeight=options.maxHeight ?? 2048;
  const maxPixels=options.maxPixels ?? 2100000;
  const scale=Math.min(1,maxWidth/fullWidth,maxHeight/fullHeight,Math.sqrt(maxPixels/(fullWidth*fullHeight)));
  const width=Math.max(1,Math.floor(fullWidth*scale)),height=Math.max(1,Math.floor(fullHeight*scale));
  const sum=new Float32Array(width*height*4);
  for (const item of accepted) {
    const left=Math.round((item.x-minX)*scale),top=Math.round((item.y-minY)*scale);
    const sw=Math.max(1,Math.round(w*scale)),sh=Math.max(1,Math.round(h*scale));
    for (let py=0;py<sh;py++) {
      const dy=top+py;
      if (dy<0 || dy>=height) continue;
      const sy=Math.min(h-1,Math.floor((py+0.5)*h/sh));
      for (let px=0;px<sw;px++) {
        const dx=left+px;
        if (dx<0 || dx>=width) continue;
        const sx=Math.min(w-1,Math.floor((px+0.5)*w/sw));
        const edge=Math.min(px,sw-1-px,py,sh-1-py);
        const feather=Math.max(0.08,Math.min(1,edge/Math.max(1,Math.min(sw,sh)*0.14)));
        const from=(sy*w+sx)*4,to=(dy*width+dx)*4;
        const alpha=item.frame.rgba[from+3]/255*feather;
        sum[to]+=item.frame.rgba[from]*alpha;
        sum[to+1]+=item.frame.rgba[from+1]*alpha;
        sum[to+2]+=item.frame.rgba[from+2]*alpha;
        sum[to+3]+=alpha;
      }
    }
  }
  const rgba=new Uint8ClampedArray(width*height*4);
  for (let i=0;i<width*height;i++) {
    const k=i*4,weight=sum[k+3];
    if (!weight) continue;
    rgba[k]=sum[k]/weight;
    rgba[k+1]=sum[k+1]/weight;
    rgba[k+2]=sum[k+2]/weight;
    rgba[k+3]=255;
  }
  return {width,height,rgba,accepted:accepted.length,captured:frames.length,positions:accepted.map(({x,y})=>({x,y}))};
}
