import { stitchPanorama } from './panorama.mjs';
self.onmessage = event => {
  try {
    const frames = event.data.map(frame => ({...frame,data:new Uint8ClampedArray(frame.data)}));
    const panorama = stitchPanorama(frames);
    self.postMessage({type:'result',...panorama,data:panorama.data.buffer},[panorama.data.buffer]);
  } catch(error) {self.postMessage({type:'error',message:error?.message||'Kunne ikkje setje saman panoramaet.'});}
};
