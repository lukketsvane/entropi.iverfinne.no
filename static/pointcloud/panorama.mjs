/** @typedef {{data: Uint8ClampedArray, width: number, height: number}} Frame */
/** @param {Frame} frame */
function gradients(frame) {
  const scale = 128 / Math.max(frame.width, frame.height);
  const width = Math.max(24, Math.round(frame.width * scale)), height = Math.max(24, Math.round(frame.height * scale));
  const gray = new Float32Array(width * height), gx = new Float32Array(gray.length), gy = new Float32Array(gray.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const left=Math.floor(x*frame.width/width),right=Math.max(left+1,Math.floor((x+1)*frame.width/width));
    const top=Math.floor(y*frame.height/height),bottom=Math.max(top+1,Math.floor((y+1)*frame.height/height));
    let sum=0,n=0;
    for(let sy=top;sy<Math.min(frame.height,bottom);sy++)for(let sx=left;sx<Math.min(frame.width,right);sx++) {
      const at=(sy*frame.width+sx)*4;
      sum+=frame.data[at]*.299+frame.data[at+1]*.587+frame.data[at+2]*.114;n++;
    }
    gray[y*width+x]=sum/Math.max(1,n);
  }
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = y * width + x; gx[i] = gray[i + 1] - gray[i - 1]; gy[i] = gray[i + width] - gray[i - width];
  }
  return {gx,gy,width,height};
}
/** @param {ReturnType<typeof gradients>} a @param {ReturnType<typeof gradients>} b @param {number} dx @param {number} dy */
function correlation(a, b, dx, dy) {
  const left = Math.max(2, 2 - dx), right = Math.min(a.width - 2, a.width - 2 - dx);
  const top = Math.max(2, 2 - dy), bottom = Math.min(a.height - 2, a.height - 2 - dy);
  let aa = 0, bb = 0, ab = 0, n = 0;
  for (let y = top; y < bottom; y += 3) for (let x = left; x < right; x += 3) {
    const i = y * a.width + x, j = (y + dy) * a.width + x + dx;
    aa += a.gx[i] ** 2 + a.gy[i] ** 2; bb += b.gx[j] ** 2 + b.gy[j] ** 2;
    ab += a.gx[i] * b.gx[j] + a.gy[i] * b.gy[j]; n++;
  }
  if (n < 120 || aa / n < 12 || bb / n < 12) return -1;
  return ab / Math.sqrt(aa * bb);
}
/** @param {Frame} previous @param {Frame} current */
export function estimateTranslation(previous, current) {
  if (previous.width !== current.width || previous.height !== current.height) return null;
  const a = gradients(previous), b = gradients(current);
  const maxX = Math.floor(a.width * .36), maxY = Math.floor(a.height * .36);
  let best = {x:0,y:0,score:-1,confidence:0};
  /** @param {number} x @param {number} y */
  function candidate(x, y) {
    const confidence = correlation(a, b, x, y);
    const score = confidence - .025 * (Math.abs(x) / a.width + Math.abs(y) / a.height);
    if (score > best.score) best = {x,y,score,confidence};
  }
  // Full pixel search avoids mistaking aliased texture for the best coarse-grid match.
  for (let y = -maxY; y <= maxY; y++) for (let x = -maxX; x <= maxX; x++) candidate(x,y);
  candidate(0,0);
  if (best.confidence < .72) return null;
  return {x:best.x * previous.width / a.width, y:best.y * previous.height / a.height, confidence:best.confidence};
}

/** Register overlapping frames; never invent an offset for unmatchable images. @param {Frame[]} frames */
export function registerFrames(frames) {
  if (!frames.length) throw new Error('Ingen bilete vart tekne.');
  if (frames.length > 32) throw new Error('For mange bilete i opptaket.');
  for (const frame of frames) {
    if (!Number.isInteger(frame.width) || !Number.isInteger(frame.height) || frame.width < 1 || frame.height < 1 || frame.width*frame.height > 1000000 || !(frame.data instanceof Uint8ClampedArray) || frame.data.length !== frame.width*frame.height*4) throw new Error('Ugyldig kamerabilete.');
  }
  const placements = [{index:0,x:0,y:0}];
  for (let index = 1; index < frames.length; index++) {
    const last = placements[placements.length - 1];
    const move = estimateTranslation(frames[last.index], frames[index]);
    if (!move || Math.hypot(move.x,move.y) < 2) continue;
    placements.push({index,x:last.x - move.x,y:last.y - move.y});
  }
  return placements;
}

/** Feather the registered frames into a bounded panorama. @param {Frame[]} frames */
export function stitchPanorama(frames) {
  const placements = registerFrames(frames);
  const minX = Math.min(...placements.map(p=>p.x)), minY = Math.min(...placements.map(p=>p.y));
  const maxX = Math.max(...placements.map(p=>p.x+frames[p.index].width)), maxY = Math.max(...placements.map(p=>p.y+frames[p.index].height));
  const spanW = maxX-minX, spanH = maxY-minY;
  const scale = Math.min(1,4096/Math.max(spanW,spanH),Math.sqrt(1600000/(spanW*spanH)));
  const width = Math.max(1,Math.ceil(spanW*scale)), height = Math.max(1,Math.ceil(spanH*scale));
  const sums = new Uint32Array(width*height*3), weights = new Uint16Array(width*height);
  for (const placement of placements) {
    const frame = frames[placement.index], left = (placement.x-minX)*scale, top = (placement.y-minY)*scale;
    for (let y=Math.max(0,Math.ceil(top));y<Math.min(height,Math.floor(top+frame.height*scale));y++) for (let x=Math.max(0,Math.ceil(left));x<Math.min(width,Math.floor(left+frame.width*scale));x++) {
      const sx=Math.min(frame.width-1,Math.floor((x-left)/scale)), sy=Math.min(frame.height-1,Math.floor((y-top)/scale));
      const weight=Math.max(1,Math.min(16,1+Math.floor(Math.min(sx,sy,frame.width-1-sx,frame.height-1-sy)/8)));
      const at=y*width+x, source=(sy*frame.width+sx)*4;
      weights[at]+=weight;
      for(let c=0;c<3;c++)sums[at*3+c]+=frame.data[source+c]*weight;
    }
  }
  const data=new Uint8ClampedArray(width*height*4);
  for(let i=0;i<weights.length;i++) if(weights[i]) {
    for(let c=0;c<3;c++)data[i*4+c]=Math.round(sums[i*3+c]/weights[i]);
    data[i*4+3]=255;
  }
  return {data,width,height,inputFrames:frames.length,registeredFrames:placements.length,
    focalEstimate:Math.max(frames[0].width,frames[0].height)*.95*scale,
    horizontal:spanW>frames[0].width*1.15,vertical:spanH>frames[0].height*1.15};
}
