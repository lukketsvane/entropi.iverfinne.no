type Point = {x: number; y: number};
type Measure = {x: number; y: number; gap: number};
type Options = {onRotate(dx: number, dy: number): void; onTransform(dx: number, dy: number, scale: number, focusX: number, focusY: number): void; onDensity(value: number): void; onDefinition(value: number): void; initialDensity?: number; onTouch?(active: boolean): void; onAdjust?(message: string, density: number | null): void};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
export const noAdjust = (_message: string, _density: number | null) => {};

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

export function attachViewerGestures(canvas: HTMLCanvasElement, {onRotate, onTransform, onDensity, onDefinition, initialDensity = 1, onTouch = () => {}, onAdjust = () => {}}: Options) {
  const pointers = new Map<number, Point>();
  const state = {density: clamp(1 + Math.log10(clamp(initialDensity, 1e-6, 1)) / 6, 0, 1), definition: .5, filter: 'none'};
  let start: Measure | null = null;
  let previous: Measure | null = null;
  let axis: 'density' | 'definition' | null = null;
  let changed = false;
  let densityChanged = false;

  const measure = () => {
    const points = [...pointers.values()];
    const x = points.reduce((sum, point) => sum + point.x, 0) / points.length;
    const y = points.reduce((sum, point) => sum + point.y, 0) / points.length;
    const gap = points.length === 2 ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) : 0;
    return {x, y, gap};
  };
  const reset = () => {
    start = previous = pointers.size > 0 && pointers.size <= 3 ? measure() : null;
    axis = null;
  };
  const down = (event: PointerEvent) => {
    if (event.pointerType !== 'touch') return;
    if (pointers.size === 0) onTouch(true);
    pointers.set(event.pointerId, {x: event.clientX, y: event.clientY});
    canvas.setPointerCapture(event.pointerId);
    reset();
    if (pointers.size > 1) event.preventDefault();
  };
  const move = (event: PointerEvent) => {
    const point = pointers.get(event.pointerId);
    if (!point) return;
    point.x = event.clientX;
    point.y = event.clientY;
    event.stopImmediatePropagation();
    event.preventDefault();
    if (pointers.size > 3 || !previous || !start) return;
    const current = measure();
    const dx = current.x - previous.x;
    const dy = current.y - previous.y;
    if (pointers.size === 1) {
      if (dx || dy) onRotate(dx, dy);
    } else if (pointers.size === 2) {
      const rect = canvas.getBoundingClientRect();
      const scale = previous.gap > 0 && current.gap > 0 ? current.gap / previous.gap : 1;
      if (dx || dy || scale !== 1) onTransform(dx, dy, scale, current.x - rect.left, current.y - rect.top);
    } else {
      if (!axis && Math.hypot(current.x - start.x, current.y - start.y) >= 10) {
        axis = Math.abs(current.x - start.x) > Math.abs(current.y - start.y) ? 'definition' : 'density';
      }
      if (axis === 'density') {
        const height = Math.max(1, canvas.clientHeight);
        const next = clamp(state.density - (current.y - previous.y) * 1.4 / height, 0, 1);
        if (next !== state.density) { state.density = next; onDensity(10 ** (-6 * (1 - next))); changed = densityChanged = true; }
        else if (dy < 0 && next === 1) changed = densityChanged = true;
      } else if (axis === 'definition') {
        const width = Math.max(1, canvas.clientWidth);
        const next = clamp(state.definition + dx * 1.4 / width, 0, 1);
        if (next !== state.definition) { state.definition = next; onDefinition(next); changed = true; }
      }
    }
    previous = current;
  };
  const up = (event: PointerEvent) => {
    if (event.pointerType !== 'touch' || !pointers.delete(event.pointerId)) return;
    if (pointers.size === 0) {
      const visibleDensity = 10 ** (-6 * (1 - state.density));
      if (changed) onAdjust(`Viste element ${Number((100 * visibleDensity).toPrecision(2))} prosent av full mengd. Punktskarpleik ${Math.round(state.definition * 100)} prosent.`, densityChanged ? visibleDensity : null);
      changed = densityChanged = false;
      onTouch(false);
    }
    reset();
  };
  canvas.addEventListener('pointerdown', down, true);
  canvas.addEventListener('pointermove', move, true);
  canvas.addEventListener('pointerup', up, true);
  canvas.addEventListener('pointercancel', up, true);
  return {
    state,
    dispose() {
      if (pointers.size) onTouch(false);
      pointers.clear();
      canvas.removeEventListener('pointerdown', down, true);
      canvas.removeEventListener('pointermove', move, true);
      canvas.removeEventListener('pointerup', up, true);
      canvas.removeEventListener('pointercancel', up, true);
    }
  };
}
