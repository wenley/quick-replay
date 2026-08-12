// Playback gain control: a persisted, dB-scaled gain applied to every
// playback source. Expressed in dB because perceived loudness is
// logarithmic — a linear multiplier slider would waste most of its travel
// on boost and leave almost none for attenuation.
//
// Constructible without an AudioContext (the slider and its listeners are
// set up at module load, before the user arms), with the actual GainNode
// created later via attach() once one exists.

import { el } from './dom.ts';

export const GAIN_MIN_DB = -30; // treated as mute
export const GAIN_MAX_DB = 18;
const GAIN_STORAGE_KEY = 'quick-replay:gain-db';

export function dbToLinear(db: number): number {
  // The bottom of the range is a true mute rather than a very quiet signal.
  if (db <= GAIN_MIN_DB) return 0;
  return Math.pow(10, db / 20);
}

function loadStoredGainDb(): number {
  try {
    const raw = localStorage.getItem(GAIN_STORAGE_KEY);
    const value = Number(raw);
    if (raw !== null && Number.isFinite(value)) {
      return Math.min(GAIN_MAX_DB, Math.max(GAIN_MIN_DB, value));
    }
  } catch { /* private mode / storage disabled — fall through to default */ }
  return 0;
}

export interface GainControl {
  /** Creates and connects the GainNode. Call once, at arm time. */
  attach(audioCtx: AudioContext): void;
  /** The node every playback source routes through; null before attach(). */
  readonly node: GainNode | null;
  readonly db: number;
  set(db: number, options?: { fromSlider?: boolean }): void;
  /** Peak of the material being replayed, for the clipping warning. */
  setMaterialPeak(peak: number): void;
  /** Keyboard +/- 1 dB. */
  nudge(deltaDb: number): void;
  /** Keyboard '0' — back to 0 dB. */
  reset(): void;
}

export function createGainControl(): GainControl {
  let gainDb = 0;
  let playbackGainNode: GainNode | null = null;
  let lastPlaybackPeak = 0;
  let audioCtx: AudioContext | null = null;

  function renderGain(): void {
    const linear = dbToLinear(gainDb);
    if (el.gainDb) {
      el.gainDb.textContent = gainDb <= GAIN_MIN_DB
        ? 'muted'
        : `${gainDb > 0 ? '+' : ''}${gainDb} dB`;
    }
    if (el.gainMult) {
      el.gainMult.textContent = `${linear.toFixed(2)}×`;
    }
    if (el.gainClipWarning) {
      // Only meaningful once we know how hot the material being replayed is.
      const willClip = lastPlaybackPeak > 0 && lastPlaybackPeak * linear > 1;
      el.gainClipWarning.classList.toggle('visible', willClip);
    }
  }

  function set(db: number, { fromSlider = false }: { fromSlider?: boolean } = {}): void {
    gainDb = Math.min(GAIN_MAX_DB, Math.max(GAIN_MIN_DB, Math.round(db)));

    const linear = dbToLinear(gainDb);
    if (playbackGainNode && audioCtx) {
      // Ramp rather than jump, so adjusting mid-replay doesn't click.
      playbackGainNode.gain.setTargetAtTime(linear, audioCtx.currentTime, 0.01);
    }

    try { localStorage.setItem(GAIN_STORAGE_KEY, String(gainDb)); } catch { /* ignore */ }

    if (!fromSlider && el.gainSlider) el.gainSlider.value = String(gainDb);
    renderGain();
  }

  // --- gain slider -----------------------------------------------------------

  if (el.gainSlider) {
    const gainSlider = el.gainSlider;
    gainSlider.min = String(GAIN_MIN_DB);
    gainSlider.max = String(GAIN_MAX_DB);
    gainSlider.addEventListener('input', () => {
      set(Number(gainSlider.value), { fromSlider: true });
    });
    // Hand focus back after a click, so the duration keys keep working without
    // the user having to click away from the slider first.
    gainSlider.addEventListener('change', () => gainSlider.blur());
  }

  return {
    attach(ctx: AudioContext): void {
      audioCtx = ctx;
      // Persistent node every playback source routes through, so the slider
      // takes effect mid-replay rather than only on the next one.
      playbackGainNode = ctx.createGain();
      playbackGainNode.connect(ctx.destination);
      set(loadStoredGainDb());
    },
    get node(): GainNode | null {
      return playbackGainNode;
    },
    get db(): number {
      return gainDb;
    },
    set,
    setMaterialPeak(peak: number): void {
      lastPlaybackPeak = peak;
      renderGain();
    },
    nudge(deltaDb: number): void {
      set(gainDb + deltaDb);
    },
    reset(): void {
      set(0);
    },
  };
}
