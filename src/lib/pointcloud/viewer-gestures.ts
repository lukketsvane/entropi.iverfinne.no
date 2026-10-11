type Point = {x: number; y: number; x0: number; y0: number};
type Measure = {x: number; y: number; gap: number};
type Options = {onDensity(value: number): void; onPinch(scale: number): void; onAdjust?(message: string): void};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
export const noAdjust = (_message: string) => {};

export function progressiveIndices(count: number) {
  const indices = Array.from({length: count}, (_, index) => index);
  let seed = 0x9e3779b9;
  for (let index = count - 1; index > 0; index--) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    const other = (seed >>> 0) % (index + 1);
    [indices[index], indices[other]] = [indices[other], indices[index]];
  }
  return indices;
}

export function attachViewerGestures(canvas: HTMLCanvasElement, {onDensity, onPinch, onAdjust = () => {}}: Options) {
  const pointers = new Map<number, Point>();
  const state = {density: 1, brightness: 1, contrast: 1, filter: 'none'};
  let active = false;
  let mode = '';
  let start: Measure | null = null;
  let previous: Measure | null = null;
  let changed = false;

  const measure = () => {
    const points = [...pointers.values()];
    const x = points.reduce((sum, point) => sum + point.x, 0) / points.length;
    const y = points.reduce((sum, point) => sum + point.y, 0) / points.length;
    const gap = points.length === 2 ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) : 0;
    return {x, y, gap};
  };
  const reset = () => {
    start = pointers.size >= 2 && pointers.size <= 3 ? measure() : null;
    previous = start;
    mode = pointers.size === 3 ? 'appearance' : 'pending';
    for (const point of pointers.values()) { point.x0 = point.x; point.y0 = point.y; }
  };
  const down = (event: PointerEvent) => {
    if (event.pointerType !== 'touch') return;
    pointers.set(event.pointerId, {x: event.clientX, y: event.clientY, x0: event.clientX, y0: event.clientY});
    if (pointers.size >= 2) {
      active = true;
      canvas.setPointerCapture(event.pointerId);
      reset();
      event.preventDefault();
    }
  };
  const move = (event: PointerEvent) => {
    const point = pointers.get(event.pointerId);
    if (!point) return;
    point.x = event.clientX; point.y = event.clientY;
    if (!active) return;
    event.stopPropagation(); event.preventDefault();
    if (pointers.size < 2 || pointers.size > 3 || !start || !previous) return;
    const current = measure();
    if (pointers.size === 2 && mode === 'pending') {
      const [first, second] = [...pointers.values()];
      const ax = first.x - first.x0, ay = first.y - first.y0;
      const bx = second.x - second.x0, by = second.y - second.y0;
      const a = Math.hypot(ax, ay), b = Math.hypot(bx, by);
      if ((a < 8 || b < 8) && Math.max(a, b) < 50) return;
      mode = a >= 8 && b >= 8 && ax * bx + ay * by > a * b * 0.4 ? 'density' : 'pinch';
      previous = start;
    }
    const width = Math.max(1, canvas.clientWidth), height = Math.max(1, canvas.clientHeight);
    if (mode === 'density') {
      const next = clamp(state.density - (current.y - previous.y) * 1.4 / height, 0.1, 1);
      if (next !== state.density) { state.density = next; onDensity(next); changed = true; }
    } else if (mode === 'pinch' && previous.gap > 0 && current.gap > 0) {
      onPinch(current.gap / previous.gap);
    } else if (mode === 'appearance') {
      const brightness = clamp(state.brightness - (current.y - previous.y) * 1.6 / height, 0.4, 2);
      const contrast = clamp(state.contrast + (current.x - previous.x) * 1.6 / width, 0.4, 2);
      if (brightness !== state.brightness || contrast !== state.contrast) {
        state.brightness = brightness; state.contrast = contrast;
        state.filter = `brightness(${brightness}) contrast(${contrast})`;
        canvas.style.filter = state.filter;
        changed = true;
      }
    }
    previous = current;
  };
  const up = (event: PointerEvent) => {
    if (!pointers.delete(event.pointerId)) return;
    if (pointers.size >= 2 && pointers.size <= 3) reset();
    else if (pointers.size === 0) {
      if (changed) onAdjust(`Visingsoppløysing ${Math.round(state.density * 100)} prosent. Lysstyrke ${Math.round(state.brightness * 100)} prosent. Kontrast ${Math.round(state.contrast * 100)} prosent.`);
      active = false; mode = ''; start = previous = null; changed = false;
    }
  };
  canvas.addEventListener('pointerdown', down, true);
  canvas.addEventListener('pointermove', move, true);
  canvas.addEventListener('pointerup', up, true);
  canvas.addEventListener('pointercancel', up, true);
  return {
    state,
    dispose() {
      pointers.clear();
      canvas.removeEventListener('pointerdown', down, true);
      canvas.removeEventListener('pointermove', move, true);
      canvas.removeEventListener('pointerup', up, true);
      canvas.removeEventListener('pointercancel', up, true);
    }
  };
}
