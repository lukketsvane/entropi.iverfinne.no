export type QualityLevel = 0 | 1 | 2 | 3;

type Options = {
  edge?: 'left' | 'right';
  levels?: number;
  initialLevel?: number;
  onLevel(level: number): void;
  onActive?(active: boolean, level: number): void;
};

type Slider = {
  edge: 'left' | 'right';
  levels: number;
  level: number;
  onLevel(level: number): void;
  onActive(active: boolean, level: number): void;
};

const surfaces = new WeakMap<Window, ReturnType<typeof listenToEdges>>();

// Both rails share one touch session. A second finger must not reach the viewer
// without a pointerdown, or leave a rail active when the first finger is lifted.
function listenToEdges(surface: Window) {
  const sliders = new Set<Slider>();
  const touches = new Set<number>();
  let owner: { slider: Slider; pointerId: number } | null = null;

  const consume = (event: PointerEvent) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const select = (slider: Slider, event: PointerEvent) => {
    const next = Math.max(0, Math.min(slider.levels - 1, slider.levels - 1 - Math.floor(event.clientY / Math.max(1, surface.innerHeight) * slider.levels)));
    if (next === slider.level) return false;
    slider.level = next;
    slider.onLevel(next);
    return true;
  };
  const release = () => {
    const previous = owner;
    owner = null;
    previous?.slider.onActive(false, previous.slider.level);
  };
  const down = (event: PointerEvent) => {
    if (event.pointerType !== 'touch') return;
    if (touches.size) {
      touches.add(event.pointerId);
      consume(event);
      return;
    }
    if (!event.isPrimary || (event.target as Element | null)?.closest?.('.access-control')) return;
    const band = Math.max(24, surface.innerWidth * 0.07);
    const slider = [...sliders].find(({edge}) => edge === 'left'
      ? event.clientX >= 0 && event.clientX <= band
      : event.clientX >= surface.innerWidth - band && event.clientX <= surface.innerWidth);
    if (!slider) return;
    owner = {slider, pointerId: event.pointerId};
    touches.add(event.pointerId);
    consume(event);
    select(slider, event);
    slider.onActive(true, slider.level);
  };
  const move = (event: PointerEvent) => {
    if (!touches.size || event.pointerType !== 'touch') return;
    consume(event);
    if (event.pointerId === owner?.pointerId && select(owner.slider, event)) {
      owner.slider.onActive(true, owner.slider.level);
    }
  };
  const up = (event: PointerEvent) => {
    if (!touches.size || event.pointerType !== 'touch') return;
    consume(event);
    touches.delete(event.pointerId);
    if (event.pointerId === owner?.pointerId) release();
  };
  const blur = () => {
    touches.clear();
    release();
  };

  surface.addEventListener('pointerdown', down, {capture: true, passive: false});
  surface.addEventListener('pointermove', move, {capture: true, passive: false});
  surface.addEventListener('pointerup', up, {capture: true, passive: false});
  surface.addEventListener('pointercancel', up, {capture: true, passive: false});
  surface.addEventListener('blur', blur);
  return {
    add(slider: Slider) { sliders.add(slider); },
    remove(slider: Slider) {
      if (owner?.slider === slider) release();
      sliders.delete(slider);
      if (sliders.size) return;
      blur();
      surface.removeEventListener('pointerdown', down, true);
      surface.removeEventListener('pointermove', move, true);
      surface.removeEventListener('pointerup', up, true);
      surface.removeEventListener('pointercancel', up, true);
      surface.removeEventListener('blur', blur);
      surfaces.delete(surface);
    }
  };
}

export function attachEdgeQualitySlider(surface: Window, {edge = 'right', levels = 4, initialLevel = 2, onLevel, onActive = () => {}}: Options) {
  const slider: Slider = {edge, levels, level: initialLevel, onLevel, onActive};
  const shared = surfaces.get(surface) ?? listenToEdges(surface);
  surfaces.set(surface, shared);
  shared.add(slider);
  let disposed = false;
  return {
    get level() { return slider.level; },
    setLevel(next: number) { slider.level = next; },
    dispose() {
      if (disposed) return;
      disposed = true;
      shared.remove(slider);
    }
  };
}
