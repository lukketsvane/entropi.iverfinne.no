import { WIDTH, buildPrintJob } from './px10-protocol.mjs';
import { ditherRGBA } from './raster.mjs';

/** Black points on white thermal paper; the screen's black backdrop consumes no paper ink.
 * @param {Uint8Array|Uint8ClampedArray} rgba @param {number} width @param {number} height */
export function ditherCloudRGBA(rgba, width, height) {
  if (rgba.length !== width * height * 4) throw new Error('Biletdata manglar.');
  const paper = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const ink = Math.min(255, Math.max(rgba[i], rgba[i + 1], rgba[i + 2]) * 1.7) * rgba[i + 3] / 255;
    paper[i] = paper[i + 1] = paper[i + 2] = 255 - ink;
    paper[i + 3] = 255;
  }
  return ditherRGBA(paper, width, height);
}

/** Capture is already rendered from genuine XYZ points, in monochrome, at paper width.
 * @param {HTMLCanvasElement} source */
export function cloudPrintJob(source) {
  const height = Math.max(1, Math.min(1024, Math.round(WIDTH * source.height / source.width)));
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH; canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Kunne ikkje klargjere utskrifta.');
  context.drawImage(source, 0, 0, WIDTH, height);
  const image = context.getImageData(0, 0, WIDTH, height);
  let first = height, last = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const at = (y * WIDTH + x) * 4;
      if (Math.max(image.data[at], image.data[at + 1], image.data[at + 2]) > 35) {
        first = Math.min(first, y); last = y; break;
      }
    }
  }
  if (last < first) throw new Error('Punktskyen har ingen synlege punkt å skrive ut.');
  // Trim the phone screen's empty top/bottom, retaining a small white margin.
  first = Math.max(0, first - 8); last = Math.min(height - 1, last + 8);
  const cropped = image.data.subarray(first * WIDTH * 4, (last + 1) * WIDTH * 4);
  return buildPrintJob(ditherCloudRGBA(cropped, WIDTH, last - first + 1));
}
