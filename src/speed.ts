// Pitch-preserving playback slowdown. 1.0 keeps the existing zero-latency
// AudioBufferSourceNode path completely untouched; anything below 1.0 takes
// a separate HTMLMediaElement path instead (see app.ts's playMediaPass),
// because AudioBufferSourceNode.playbackRate resamples — it would drop the
// pitch along with the speed, which is exactly what pitch-preserving means
// we must not do. Speed never exceeds 1.0; this app never speeds audio up.
// Unlike gain, it doesn't need audioCtx to load, so it's read from storage
// eagerly at construction rather than deferred to arm-time.

import { el, flashMessage } from './dom.ts';
import { formatSpeed } from './format.ts';

export const SPEED_MIN = 0.25;
export const SPEED_MAX = 1.0;
const SPEED_STORAGE_KEY = 'quick-replay:speed';

function loadStoredSpeed(): number {
  try {
    const raw = localStorage.getItem(SPEED_STORAGE_KEY);
    const value = Number(raw);
    if (raw !== null && Number.isFinite(value)) {
      return Math.min(SPEED_MAX, Math.max(SPEED_MIN, value));
    }
  } catch { /* private mode / storage disabled — fall through to default */ }
  return 1;
}

// `x` — cycles 1.0 -> 0.75 -> 0.5 -> back to 1.0. Steps down from wherever
// the slider currently sits (so an in-between slider value like 0.83 cycles
// to the next step down rather than snapping to a fixed sequence position).
// Steps down through the presets and wraps back to full speed. Includes the
// slider's floor so the keyboard can reach the whole range on its own.
const SPEED_STEPS = [0.75, 0.5, 0.25];

export interface SpeedControl {
  readonly value: number;
  set(value: number, options?: { fromSlider?: boolean }): void;
  /** Keyboard 'x' — steps down through the presets, wrapping to 1.0. */
  cycle(): void;
}

/** `onChanged` fires only when the value actually changed, AFTER it has been
 *  persisted and rendered — matching the current ordering exactly. */
export function createSpeedControl(onChanged: () => void): SpeedControl {
  let speed = loadStoredSpeed();

  function renderSpeed(): void {
    if (el.speedValue) el.speedValue.textContent = formatSpeed(speed);
  }

  function set(newSpeed: number, { fromSlider = false }: { fromSlider?: boolean } = {}): void {
    const clamped = Math.min(SPEED_MAX, Math.max(SPEED_MIN, newSpeed));
    const changed = Math.abs(clamped - speed) > 1e-9;
    speed = clamped;

    try { localStorage.setItem(SPEED_STORAGE_KEY, String(speed)); } catch { /* ignore */ }

    if (!fromSlider && el.speedSlider) el.speedSlider.value = String(speed);
    renderSpeed();

    if (changed) onChanged();
  }

  function cycle(): void {
    const next = SPEED_STEPS.find((step) => speed > step + 1e-9) ?? SPEED_MAX;
    set(next);
    flashMessage(`speed ${formatSpeed(next)}`);
  }

  // --- speed slider ------------------------------------------------------------

  if (el.speedSlider) {
    const speedSlider = el.speedSlider;
    speedSlider.min = String(SPEED_MIN);
    speedSlider.max = String(SPEED_MAX);
    speedSlider.step = '0.01';
    speedSlider.value = String(speed);
    speedSlider.addEventListener('input', () => {
      set(Number(speedSlider.value), { fromSlider: true });
    });
    // Same reasoning as the gain slider: hand focus back after a click so
    // duration keys keep working without clicking away first.
    speedSlider.addEventListener('change', () => speedSlider.blur());
  }
  renderSpeed();

  return {
    get value(): number {
      return speed;
    },
    set,
    cycle,
  };
}
