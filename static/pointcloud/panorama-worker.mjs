import { stitchFrames } from './panorama.mjs';

self.onmessage = (event) => {
  try {
    const frames = event.data.frames.map(frame => ({
      width: frame.width,
      height: frame.height,
      rgba: new Uint8ClampedArray(frame.rgba)
    }));
    const result = stitchFrames(frames);
    self.postMessage({
      type: 'result', width: result.width, height: result.height,
      rgba: result.rgba.buffer, accepted: result.accepted, captured: result.captured
    }, [result.rgba.buffer]);
  } catch (error) {
    self.postMessage({type:'error', message:error?.message || 'Kunne ikkje setje saman panoramaet.'});
  }
};
