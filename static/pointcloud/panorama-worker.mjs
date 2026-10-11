import { stitchPanorama } from './panorama.mjs';
self.onmessage = event => {
  try {
    const frames = event.data.frames.map(frame => ({...frame,data:new Uint8ClampedArray(frame.data)}));
    const panorama = stitchPanorama(frames);
    self.postMessage({...panorama,data:panorama.data.buffer},[panorama.data.buffer]);
  } catch(error) {self.postMessage({error:error?.message||'Kunne ikkje setje saman panoramaet.'});}
};
