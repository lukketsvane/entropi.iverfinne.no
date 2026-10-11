export const C64_PALETTE: [number, number, number][] = [
  [0, 0, 0], [255, 255, 255], [150, 40, 46], [91, 214, 206],
  [159, 45, 173], [65, 185, 54], [39, 36, 196], [239, 243, 71],
  [159, 72, 21], [94, 53, 0], [218, 95, 102], [71, 71, 71],
  [120, 120, 120], [145, 255, 132], [104, 100, 255], [174, 174, 174]
];
const tones = C64_PALETTE.map(color => ({
  color,
  chroma: Math.max(...color) - Math.min(...color),
  u: color[0] - (color[1] + color[2]) / 2,
  v: (color[1] - color[2]) * Math.sqrt(3) / 2
}));

export function nearestC64(red: number, green: number, blue: number): [number, number, number] {
  let selected = C64_PALETTE[0];
  let best = Infinity;
  const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
  const u = red - (green + blue) / 2;
  const v = (green - blue) * Math.sqrt(3) / 2;
  for (const tone of tones) {
    const color = tone.color;
    const distance = (red - color[0]) ** 2 + (green - color[1]) ** 2 + (blue - color[2]) ** 2 +
      1.5 * ((u - tone.u) ** 2 + (v - tone.v) ** 2) + (chroma - tone.chroma) ** 2;
    if (distance < best) {
      best = distance;
      selected = color;
    }
  }
  return selected;
}
