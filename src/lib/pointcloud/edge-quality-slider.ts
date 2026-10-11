export type QualityLevel = 0 | 1 | 2 | 3;

type Options = {
  initialLevel?: QualityLevel;
  onLevel(level: QualityLevel): void;
  onActive?(active: boolean, level: QualityLevel): void;
};

const clampLevel = (value: number) => Math.max(0, Math.min(3, value)) as QualityLevel;

export function attachEdgeQualitySlider(surface: Window, {initialLevel = 2, onLevel, onActive = () => {}}: Options) {
  let level = initialLevel;
  let pointerId: number | null = null;

  const consume = (event: PointerEvent) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const select = (event: PointerEvent) => {
    const next = clampLevel(3 - Math.floor(event.clientY / Math.max(1, surface.innerHeight) * 4));
    if (next !== level) {
      level = next;
      onLevel(level);
    }
  };
  const down = (event: PointerEvent) => {
    if (event.pointerType !== 'touch') return;
    if (pointerId !== null) { consume(event); return; }
    if (!event.isPrimary || (event.target as Element | null)?.closest?.('.access-control')) return;
    const edge = Math.max(24, surface.innerWidth * 0.07);
    if (event.clientX < surface.innerWidth - edge || event.clientX > surface.innerWidth) return;
    pointerId = event.pointerId;
    consume(event);
    select(event);
    onActive(true, level);
  };
  const move = (event: PointerEvent) => {
    if (pointerId === null || event.pointerType !== 'touch') return;
    consume(event);
    if (event.pointerId !== pointerId) return;
    const previous = level;
    select(event);
    if (level !== previous) onActive(true, level);
  };
  const up = (event: PointerEvent) => {
    if (pointerId === null || event.pointerType !== 'touch') return;
    consume(event);
    if (event.pointerId !== pointerId) return;
    pointerId = null;
    onActive(false, level);
  };
  const blur = () => {
    if (pointerId === null) return;
    pointerId = null;
    onActive(false, level);
  };

  surface.addEventListener('pointerdown', down, {capture: true, passive: false});
  surface.addEventListener('pointermove', move, {capture: true, passive: false});
  surface.addEventListener('pointerup', up, {capture: true, passive: false});
  surface.addEventListener('pointercancel', up, {capture: true, passive: false});
  surface.addEventListener('blur', blur);
  return {
    get level() { return level; },
    setLevel(next: QualityLevel) { level = next; },
    dispose() {
      blur();
      surface.removeEventListener('pointerdown', down, true);
      surface.removeEventListener('pointermove', move, true);
      surface.removeEventListener('pointerup', up, true);
      surface.removeEventListener('pointercancel', up, true);
      surface.removeEventListener('blur', blur);
    }
  };
}
