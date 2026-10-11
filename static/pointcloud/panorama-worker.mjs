import { stitchPanorama } from './panorama.mjs';

/**
 * Protocol shared with the capture page:
 * input: an array of {width,height,data:ArrayBuffer}
 * output: {type:'result',data:ArrayBuffer,width,height,...}
 *
 * A previous worker expected {frames:[...]} and returned no "type" field.
 * Consequently EVERY held recording failed before 3D inference could begin.
 */
self.onmessage = (event) => {
  try {
    const input = Array.isArray(event.data) ? event.data : event.data?.frames;
    if (!Array.isArray(input) || !input.length || input.length > 32) {
      throw new Error('Ingen gyldige kamerabilete.');
    }
    const frames = input.map(frame => ({
      width: frame.width,
      height: frame.height,
      data: new Uint8ClampedArray(frame.data)
    }));
    const panorama = stitchPanorama(frames);
    self.postMessage({
      type: 'result',
      ...panorama,
      data: panorama.data.buffer
    }, [panorama.data.buffer]);
  } catch (error) {
    self.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : 'Kunne ikkje setje saman panoramaet.'
    });
  }
};
