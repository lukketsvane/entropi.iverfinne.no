/** Display colours, in sRGB bytes. The image is reduced after the splats blend. */
export type PrimitiveLevel = 0 | 1 | 2 | 3;
export type PrimitiveColor = readonly [number, number, number];

const EGA: readonly PrimitiveColor[] = [
  [0, 0, 0], [0, 0, 170], [0, 170, 0], [0, 170, 170],
  [170, 0, 0], [170, 0, 170], [170, 85, 0], [170, 170, 170],
  [85, 85, 85], [85, 85, 255], [85, 255, 85], [85, 255, 255],
  [255, 85, 85], [255, 85, 255], [255, 255, 85], [255, 255, 255]
];
const CGA: readonly PrimitiveColor[] = [[0, 0, 0], [0, 255, 255], [255, 0, 255], [255, 255, 255]];
const GREEN: readonly PrimitiveColor[] = [[0, 0, 0], [0, 255, 102]];

export const PRIMITIVE_MODES: readonly {
  label: string;
  width: number;
  height: number;
  /** Displayed width of a pixel divided by its displayed height. */
  pixelAspect: number;
  palette: readonly PrimitiveColor[];
  dither: number;
}[] = [
  {label: 'Dagens C64-fargar', width: 0, height: 0, pixelAspect: 1, palette: [], dither: 0},
  {label: 'EGA: seksten fargar og grove pikslar', width: 640, height: 350, pixelAspect: 1, palette: EGA, dither: 48},
  {label: 'CGA: fire fargar og rektangulære pikslar', width: 320, height: 200, pixelAspect: 5 / 6, palette: CGA, dither: 144},
  {label: 'Grøn fosfor: to fargar og rutemønster', width: 320, height: 200, pixelAspect: 5 / 6, palette: GREEN, dither: 255}
];

/** Shared by the CPU and the screen shader; fixed in image space, never time. */
export const PRIMITIVE_BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5] as const;

export function normalizePrimitiveLevel(level: number): PrimitiveLevel {
  return (Number.isFinite(level) ? Math.max(0, Math.min(3, Math.round(level))) : 0) as PrimitiveLevel;
}

function dimension(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : 1;
}

/** Fit the old display grid to the view, without changing the camera or canvas. */
export function primitiveDimensions(level: number, width: number, height: number): {width: number; height: number} {
  const w = dimension(width), h = dimension(height);
  const selected = normalizePrimitiveLevel(level);
  if (!selected) return {width: w, height: h};
  const mode = PRIMITIVE_MODES[selected];
  const sourceWidth = w / mode.pixelAspect;
  const scale = Math.min(1, mode.width / sourceWidth, mode.height / h);
  return {width: Math.max(1, Math.floor(sourceWidth * scale)), height: Math.max(1, Math.floor(h * scale))};
}

function byte(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(255, value)) : 0;
}

/** Quantize display-space sRGB, after composition. Coordinates are low-res pixels. */
export function primitiveColor(level: number, red: number, green: number, blue: number, x: number, y: number): [number, number, number] {
  const selected = normalizePrimitiveLevel(level);
  if (!selected) return [red, green, blue];
  const mode = PRIMITIVE_MODES[selected];
  const column = Number.isFinite(x) ? ((Math.floor(x) % 4) + 4) % 4 : 0;
  const row = Number.isFinite(y) ? ((Math.floor(y) % 4) + 4) % 4 : 0;
  const threshold = (PRIMITIVE_BAYER[row * 4 + column] + .5) / 16 - .5;
  let r = byte(red), g = byte(green), b = byte(blue);
  if (selected === 3) {
    // Match the phosphor's luminance so an exact green swatch stays green.
    const intensity = Math.max(0, Math.min(1, (r * .2126 + g * .7152 + b * .0722) / (255 * .7152 + 102 * .0722) + threshold * mode.dither / 255));
    r = 0; g = 255 * intensity; b = 102 * intensity;
  } else {
    const noise = threshold * mode.dither;
    r = byte(r + noise); g = byte(g + noise); b = byte(b + noise);
  }
  let closest = mode.palette[0], distance = Infinity;
  for (const color of mode.palette) {
    const next = (r - color[0]) ** 2 + (g - color[1]) ** 2 + (b - color[2]) ** 2;
    if (next < distance) { closest = color; distance = next; }
  }
  return [closest[0], closest[1], closest[2]];
}

/** Mutate an RGBA Canvas2D image, compositing transparency onto the black view. */
export function applyPrimitivePixels<T extends Uint8ClampedArray | Uint8Array>(level: number, rgba: T, width: number, height: number): T {
  const selected = normalizePrimitiveLevel(level);
  if (!selected) return rgba;
  const w = dimension(width), h = dimension(height);
  const count = Math.min(w * h, Math.floor(rgba.length / 4));
  for (let i = 0; i < count; i++) {
    const offset = i * 4, alpha = rgba[offset + 3] / 255;
    const color = primitiveColor(selected, rgba[offset] * alpha, rgba[offset + 1] * alpha, rgba[offset + 2] * alpha, i % w, Math.floor(i / w));
    rgba[offset] = color[0]; rgba[offset + 1] = color[1]; rgba[offset + 2] = color[2]; rgba[offset + 3] = 255;
  }
  return rgba;
}
