/** @typedef {{id:string,label:string,stops:[number,number[]][]}} Look */
/** Colour looks are gradient maps: the depth tone picks a colour along a ramp. @type {readonly Look[]} */
export const LOOKS = Object.freeze(/** @type {Look[]} */ ([
  { id: 'mono', label: 'Mono', stops: [[0, [0, 0, 0]], [1, [255, 255, 255]]] },
  { id: 'blue', label: 'Blå', stops: [[0, [5, 12, 30]], [.45, [52, 92, 146]], [.8, [158, 197, 224]], [1, [244, 250, 253]]] },
  { id: 'amber', label: 'Rav', stops: [[0, [18, 7, 3]], [.45, [148, 68, 28]], [.8, [232, 162, 94]], [1, [255, 244, 226]]] },
  { id: 'spectrum', label: 'Spekter', stops: [[0, [18, 22, 88]], [.35, [28, 108, 160]], [.68, [96, 182, 118]], [1, [246, 232, 122]]] },
  { id: 'green', label: 'Grøn', stops: [[0, [3, 20, 13]], [.5, [40, 118, 78]], [1, [222, 248, 232]]] },
  { id: 'violet', label: 'Fiol', stops: [[0, [16, 0, 24]], [.4, [138, 20, 148]], [.75, [200, 172, 206]], [1, [232, 255, 242]]] },
  { id: 'lilac', label: 'Lavendel', stops: [[0, [10, 34, 36]], [.5, [150, 135, 192]], [1, [222, 250, 240]]] },
  { id: 'rose', label: 'Rosa', stops: [[0, [24, 16, 92]], [.35, [80, 96, 232]], [.7, [240, 162, 160]], [1, [250, 246, 248]]] },
]).map(look => Object.freeze(look)));

const ramps = LOOKS.map(({ stops }) => {
  const table = new Uint8ClampedArray(256 * 3);
  for (let v = 0; v < 256; v++) {
    const t = v / 255, upper = stops.findIndex(([at]) => at >= t), [a, from] = stops[Math.max(0, upper - 1)], [b, to] = stops[Math.max(0, upper)];
    const k = b > a ? (t - a) / (b - a) : 0;
    for (let c = 0; c < 3; c++) table[v * 3 + c] = from[c] + (to[c] - from[c]) * k;
  }
  return table;
});

// Film grain from a fixed tile, so the same image always gets the same grain.
const grainTile = (() => {
  const tile = new Float32Array(256 * 256);
  let seed = 0x9e3779b9;
  for (let i = 0; i < tile.length; i++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    const a = (seed >>> 0) / 4294967296;
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    tile[i] = a - (seed >>> 0) / 4294967296;
  }
  return tile;
})();

/** Box blur of a single channel in place-free O(n), used for detail extraction.
 * @param {Float32Array} values @param {number} width @param {number} height @param {number} radius */
export function boxBlur(values, width, height, radius) {
  const across = new Float32Array(values.length), out = new Float32Array(values.length), size = radius * 2 + 1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let x = -radius; x <= radius; x++) sum += values[row + Math.min(width - 1, Math.max(0, x))];
    for (let x = 0; x < width; x++) {
      across[row + x] = sum / size;
      sum += values[row + Math.min(width - 1, x + radius + 1)] - values[row + Math.max(0, x - radius)];
    }
  }
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) sum += across[Math.min(height - 1, Math.max(0, y)) * width + x];
    for (let y = 0; y < height; y++) {
      out[y * width + x] = sum / size;
      sum += across[Math.min(height - 1, y + radius + 1) * width + x] - across[Math.max(0, y - radius) * width + x];
    }
  }
  return out;
}

/** Fine luminance structure of the photograph (high-pass, about -1…1), at the photo's size.
 * @param {Uint8ClampedArray} rgba @param {number} width @param {number} height */
export function photoDetail(rgba, width, height) {
  const luminance = new Float32Array(width * height);
  for (let i = 0; i < luminance.length; i++) luminance[i] = (rgba[i * 4] * .2126 + rgba[i * 4 + 1] * .7152 + rgba[i * 4 + 2] * .0722) / 255;
  const blurred = boxBlur(luminance, width, height, Math.max(2, Math.round(Math.min(width, height) / 150)));
  for (let i = 0; i < luminance.length; i++) luminance[i] -= blurred[i];
  return luminance;
}

/** Turn a greyscale depth tone (RGBA) into the finished look, in place.
 * @param {Uint8ClampedArray} pixels @param {number} width @param {number} height
 * @param {{look?:number,strength?:number,structure?:number,grain?:number}} options @param {Float32Array|null} [detail] */
export function finishArt(pixels, width, height, { look = 0, strength = 1, structure = 0, grain = 0 } = {}, detail = null) {
  const ramp = ramps[Number.isInteger(look) && look >= 0 && look < ramps.length ? look : 0];
  const mix = Math.max(0, Math.min(1, strength)), texture = detail ? Math.max(0, Math.min(1, structure)) * 640 : 0, noise = Math.max(0, Math.min(1, grain)) * 48;
  if (look === 0 && !texture && !noise) return pixels;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x, at = i * 4;
    let v = pixels[at];
    if (texture) v += (detail?.[i] ?? 0) * texture;
    if (noise) v += grainTile[(y & 255) * 256 + (x & 255)] * noise;
    v = v < 0 ? 0 : v > 255 ? 255 : v | 0;
    for (let c = 0; c < 3; c++) pixels[at + c] = v + (ramp[v * 3 + c] - v) * mix;
  }
  return pixels;
}
