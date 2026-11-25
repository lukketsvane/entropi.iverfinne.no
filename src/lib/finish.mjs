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

/** Error-diffusion kernels as [dx, dy, weight] with their divisor. @type {Record<string, [number, number[][]]>} */
const KERNELS = {
  floyd: [16, [[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]]],
  atkinson: [8, [[1, 0, 1], [2, 0, 1], [-1, 1, 1], [0, 1, 1], [1, 1, 1], [0, 2, 1]]],
  stucki: [42, [[1, 0, 8], [2, 0, 4], [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2], [-2, 2, 1], [-1, 2, 2], [0, 2, 4], [1, 2, 2], [2, 2, 1]]],
  sierra: [32, [[1, 0, 5], [2, 0, 3], [-2, 1, 2], [-1, 1, 4], [0, 1, 5], [1, 1, 4], [2, 1, 2], [-1, 2, 2], [0, 2, 3], [1, 2, 2]]],
  sierra2: [16, [[1, 0, 4], [2, 0, 3], [-2, 1, 1], [-1, 1, 2], [0, 1, 3], [1, 1, 2], [2, 1, 1]]],
  sierralite: [4, [[1, 0, 2], [-1, 1, 1], [0, 1, 1]]],
};
/** @typedef {{id:string,label:string}} Dither */
/** @type {readonly Dither[]} */
export const DITHERS = Object.freeze([
  { id: 'off', label: 'Av' }, { id: 'floyd', label: 'Floyd–Steinberg' }, { id: 'atkinson', label: 'Atkinson' }, { id: 'stucki', label: 'Stucki' },
  { id: 'sierra', label: 'Sierra' }, { id: 'sierra2', label: 'To-rads Sierra' }, { id: 'sierralite', label: 'Sierra Lite' }, { id: 'bayer', label: 'Bayer' },
  { id: 'stipple', label: 'Prikk' }, { id: 'lines', label: 'Linjer' }, { id: 'waves', label: 'Bølgjer' }, { id: 'diamond', label: 'Diamant' },
].map(dither => Object.freeze(dither)));

const BAYER = (() => {
  const m = new Float32Array(64);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    let v = 0;
    for (let bit = 0, xc = x ^ y, yc = y; bit < 3; bit++, xc >>= 1, yc >>= 1) v = (v << 2) | ((xc & 1) << 1) | (yc & 1);
    m[y * 8 + x] = (v + .5) / 64 * 255;
  }
  return m;
})();
const frac = (/** @type {number} */ v) => v - Math.floor(v);

/** Two-tone dithering of a grey tone, in place. Cell is the dot size; threshold moves the cut (-1…1).
 * @param {Uint8ClampedArray} tone @param {number} width @param {number} height @param {string} style @param {number} cell @param {number} threshold */
export function ditherTone(tone, width, height, style, cell = 1, threshold = 0) {
  const s = Math.max(1, Math.min(20, Math.round(cell))), bias = Math.max(-1, Math.min(1, threshold)) * 127;
  if (style === 'lines' || style === 'waves' || style === 'diamond') {
    // Pattern line art in the manner of depth engravings: spacing grows with the cell size.
    const p = 4 + s * 2;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = y * width + x, v = Math.max(0, Math.min(255, tone[i] + bias)) / 255, c = 1 - v;
      let black;
      if (style === 'lines') black = frac((y + v * p * 3) / p) < c;
      else if (style === 'waves') black = frac(y / p + Math.sin(x * Math.PI * 2 / (p * 8)) * (.15 + c * .6)) < c;
      else {
        const d = Math.abs(frac(x / p) - .5) + Math.abs(frac(y / p) - .5);
        black = c <= .5 ? d < Math.sqrt(c / 2) : d <= 1 - Math.sqrt((1 - c) / 2);
      }
      tone[i] = black ? 0 : 255;
    }
    return tone;
  }
  const cw = Math.ceil(width / s), ch = Math.ceil(height / s), grid = new Float32Array(cw * ch), counts = new Float32Array(cw * ch);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const g = Math.floor(y / s) * cw + Math.floor(x / s); grid[g] += tone[y * width + x]; counts[g]++; }
  for (let g = 0; g < grid.length; g++) grid[g] = grid[g] / counts[g] + bias;
  const out = new Uint8Array(grid.length), kernel = KERNELS[style];
  if (kernel) {
    const [divisor, taps] = kernel;
    for (let y = 0; y < ch; y++) {
      // Serpentine scanning keeps diffusion from drifting in one direction.
      const back = y & 1;
      for (let k = 0; k < cw; k++) {
        const x = back ? cw - 1 - k : k, g = y * cw + x, old = grid[g], value = old < 128 ? 0 : 255, error = (old - value) / divisor;
        out[g] = value;
        for (const [dx, dy, weight] of taps) {
          const nx = back ? x - dx : x + dx, ny = y + dy;
          if (nx >= 0 && nx < cw && ny < ch) grid[ny * cw + nx] += error * weight;
        }
      }
    }
  } else for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const g = y * cw + x;
    const limit = style === 'bayer' ? BAYER[(y & 7) * 8 + (x & 7)] : frac(52.9829189 * frac(.06711056 * x + .00583715 * y)) * 255;
    out[g] = grid[g] < limit ? 0 : 255;
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) tone[y * width + x] = out[Math.floor(y / s) * cw + Math.floor(x / s)];
  return tone;
}

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
 * @param {{look?:number,strength?:number,structure?:number,grain?:number,brightness?:number,dither?:number,cell?:number,threshold?:number,invert?:boolean}} options @param {Float32Array|null} [detail] */
export function finishArt(pixels, width, height, { look = 0, strength = 1, structure = 0, grain = 0, brightness = 0, dither = 0, cell = 1, threshold = 0, invert = false } = {}, detail = null) {
  const ramp = ramps[Number.isInteger(look) && look >= 0 && look < ramps.length ? look : 0];
  const mix = Math.max(0, Math.min(1, strength)), texture = detail ? Math.max(0, Math.min(1, structure)) * 640 : 0, noise = Math.max(0, Math.min(1, grain)) * 48;
  const style = Number.isInteger(dither) && dither > 0 && dither < DITHERS.length ? DITHERS[dither].id : '';
  const lift = Math.max(-1, Math.min(1, brightness)) * 128;
  if (look === 0 && !texture && !noise && !style && !invert && !lift) return pixels;
  const tone = new Uint8ClampedArray(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    let v = pixels[i * 4] + lift;
    if (texture) v += (detail?.[i] ?? 0) * texture;
    if (noise) v += grainTile[(y & 255) * 256 + (x & 255)] * noise;
    tone[i] = v;
  }
  if (style) ditherTone(tone, width, height, style, cell, threshold);
  for (let i = 0; i < tone.length; i++) {
    const v = invert ? 255 - tone[i] : tone[i], at = i * 4;
    for (let c = 0; c < 3; c++) pixels[at + c] = v + (ramp[v * 3 + c] - v) * mix;
  }
  return pixels;
}
