// The playback engine: replaying a stretch of the ring buffer, either at
// full speed (zero-latency AudioBufferSourceNode) or slowed down with pitch
// preserved (HTMLAudioElement, the only thing that gets us native
// pitch-preserving time-stretch). Owns the generation-guarded onended/loop
// accounting that makes interrupting, re-triggering, and toggling loop
// mid-playback all behave correctly.

import type { RingBuffer } from './ring-buffer.ts';
import type { PlaybackSpan } from './timeline.ts';
import { el } from './dom.ts';
import { encodeWavBlob } from './wav.ts';

export interface PlaybackDeps {
  audioCtx: AudioContext;
  ringBuffer: RingBuffer;
  /** The node every source routes through. Null falls back to destination. */
  getOutputNode: () => GainNode | null;
  getSpeed: () => number;
  /** A playback finished naturally — not superseded, not looping. */
  onEnded: () => void;
  /** Peak of the material about to play, for the clipping warning. */
  onMaterialPeak: (peak: number) => void;
}

export interface Playback {
  start(seconds: number, label: string | null): void;
  stop(): void;
  /** Retune a running stretched playback without restarting it. */
  retuneSpeed(): void;
  /** True when the running playback is on the media-element (stretched) path. */
  readonly isStretching: boolean;
  /** The stretch of buffer the current replay is drawn from. */
  readonly span: PlaybackSpan;
  readonly lastSeconds: number;
  readonly lastLabel: string | null;
  readonly looping: boolean;
  setLooping(value: boolean): void;
}

// Looping playback. Global toggle, not per-playback — it can be flipped at
// any time, including mid-playback, and is read fresh at the moment each
// pass ends (see playBuffer's onended). It intentionally does not need
// audioCtx to load, unlike gain, so it's read from storage eagerly here
// rather than deferred to arm-time.
const LOOP_STORAGE_KEY = 'quick-replay:looping';
// Floor on the gap between passes. Without it, a pathologically short clip
// (e.g. a 1-frame take) would have onended fire again almost immediately,
// spinning the event loop in a tight restart cycle.
const MIN_LOOP_PASS_SECONDS = 0.1;

function loadStoredLooping(): boolean {
  try {
    return localStorage.getItem(LOOP_STORAGE_KEY) === '1';
  } catch { /* private mode / storage disabled — fall through to default */ }
  return false;
}

// Legacy aliases some browsers used before `preservesPitch` was
// standardized. Not part of the DOM lib's HTMLMediaElement typings.
interface LegacyPreservesPitch {
  webkitPreservesPitch?: boolean;
  mozPreservesPitch?: boolean;
}

export function createPlayback(deps: PlaybackDeps): Playback {
  let currentPlaybackSource: AudioBufferSourceNode | HTMLAudioElement | null = null;
  let playbackGeneration = 0; // bumped whenever a playback source is superseded
  let playbackStartTime = 0;
  let playbackDurationSeconds = 0;
  let lastPlaybackSeconds = 0;
  let lastPlaybackLabel: string | null = null;
  let playbackSpanStartAbs = 0;
  let playbackSpanEndAbs = 0;
  let progressRaf: number | null = null;

  let looping = loadStoredLooping();

  // The media-element playback path (speed < 1.0 only). Created lazily, once,
  // on first use — createMediaElementSource() throws if called twice on the
  // same element, and a fresh element+node per playback would leak nodes.
  // Every subsequent slowed playback just swaps `src` on the same element.
  let mediaAudioEl: HTMLAudioElement | null = null;
  let mediaSourceNode: MediaElementAudioSourceNode | null = null;
  let mediaBlobUrl: string | null = null; // previous blob: URL, so it can be revoked before replacing
  let mediaClipSeconds = 0; // clip length in clip-time, for re-basing on a live rate change

  // --- playback progress loop ----------------------------------------------

  function startProgressLoop(): void {
    function tick(): void {
      if (!currentPlaybackSource) return;
      const elapsed = deps.audioCtx.currentTime - playbackStartTime;
      const ratio = playbackDurationSeconds > 0
        ? Math.min(1, elapsed / playbackDurationSeconds)
        : 1;
      renderPlaybackProgress(ratio);
      if (ratio < 1 && currentPlaybackSource) {
        progressRaf = requestAnimationFrame(tick);
      } else {
        progressRaf = null;
      }
    }
    progressRaf = requestAnimationFrame(tick);
  }

  function stopProgressLoop(): void {
    if (progressRaf != null) cancelAnimationFrame(progressRaf);
    progressRaf = null;
  }

  function renderPlaybackProgress(ratio: number): void {
    if (!el.playbackProgressFill) return;
    el.playbackProgressFill.style.width = `${Math.round(ratio * 100)}%`;
  }

  // Creates the reused <audio> element and its MediaElementAudioSourceNode
  // exactly once, wiring it into the same gain node every AudioBufferSourceNode
  // also goes through, so the gain slider applies either way. Must never be
  // called more than once per element instance — see the module-level comment
  // on `mediaAudioEl`.
  function ensureMediaElement(): HTMLAudioElement {
    if (mediaAudioEl) return mediaAudioEl;
    const ctx = deps.audioCtx;
    mediaAudioEl = new Audio();
    mediaAudioEl.preload = 'auto';
    mediaSourceNode = ctx.createMediaElementSource(mediaAudioEl);
    mediaSourceNode.connect(deps.getOutputNode() || ctx.destination);
    return mediaAudioEl;
  }

  // --- playback --------------------------------------------------------------

  function startPlayback(seconds: number, label: string | null): void {
    const ctx = deps.audioCtx;
    const buf = deps.ringBuffer;

    const frames = Math.floor(seconds * ctx.sampleRate);
    const samples = buf.readLast(frames);
    // Which stretch of the buffer this replay is drawn from, in absolute frame
    // positions so the timeline can light it up. Captured here rather than
    // derived at render time because readLast may have returned fewer frames
    // than asked for, and the span must reflect what is actually being heard.
    playbackSpanEndAbs = buf.totalWritten;
    playbackSpanStartAbs = playbackSpanEndAbs - samples.length;
    lastPlaybackSeconds = seconds;
    lastPlaybackLabel = label;

    playbackGeneration++;
    const myPlaybackGen = playbackGeneration;

    if (samples.length === 0) {
      // Nothing to play (shouldn't normally happen — callers guard on
      // ringBuffer.available === 0 before dispatching). Treat as instantly
      // finished so the state machine still returns to its previous mode.
      playbackDurationSeconds = 0;
      currentPlaybackSource = null;
      setTimeout(() => {
        if (myPlaybackGen !== playbackGeneration) return;
        deps.onEnded();
      }, 0);
      return;
    }

    // Peak of the material being replayed, for the clip warning. Subsampled:
    // a 5-minute window is ~14M samples and scanning all of them would add
    // real latency to the one action this whole app exists to make instant.
    let peak = 0;
    for (let i = 0; i < samples.length; i += 16) {
      const abs = Math.abs(samples[i]);
      if (abs > peak) peak = abs;
    }
    deps.onMaterialPeak(peak);

    // At 1.0x, the existing zero-latency AudioBufferSourceNode path is
    // untouched. Only below 1.0 do we pay for the WAV-encode + media-element
    // detour required to get pitch-preserving slowdown.
    if (deps.getSpeed() < 1) {
      startMediaPlayback(samples, myPlaybackGen);
      return;
    }

    const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);

    playBuffer(buffer, myPlaybackGen);
  }

  // Plays one pass of `buffer` through the gain control's node. Used both for the
  // initial playback and for every looping restart — the restart path reuses
  // the exact same AudioBuffer rather than re-reading the ring buffer, so a
  // looped clip is guaranteed to be the same audio on every pass.
  //
  // A fresh AudioBufferSourceNode is created per pass (never
  // `source.loop = true`): that keeps every pass going through the same
  // onended -> generation-guard -> dispatch accounting as a one-shot playback,
  // which is what makes "finish the current pass, then stop" possible when
  // looping is toggled off mid-playback, and what lets the progress bar reset
  // per pass instead of pinning at 100%.
  function playBuffer(buffer: AudioBuffer, myPlaybackGen: number): void {
    const ctx = deps.audioCtx;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(deps.getOutputNode() || ctx.destination);

    source.onended = () => {
      // onended fires on manual .stop() too — no-op if this source has since
      // been superseded by a newer playback (re-trigger, back, escape, etc).
      if (myPlaybackGen !== playbackGeneration) return;
      currentPlaybackSource = null;

      // Read `looping` fresh here, not at playback start — flipping it mid-
      // playback must take effect at the next pass boundary, in either
      // direction.
      if (looping) {
        // Restart the SAME buffer for another pass, without dispatching
        // `playbackEnded` — that would leave Playback mode, which looping
        // must not do. Floor the gap so a very short clip can't restart faster
        // than MIN_LOOP_PASS_SECONDS.
        const delayMs = Math.max(0, MIN_LOOP_PASS_SECONDS - playbackDurationSeconds) * 1000;
        setTimeout(() => {
          if (myPlaybackGen !== playbackGeneration) return;
          if (!looping) {
            // Toggled off during the gap: finish as a normal (non-looping)
            // ending rather than starting another pass.
            stopProgressLoop();
            deps.onEnded();
            return;
          }
          playBuffer(buffer, myPlaybackGen);
        }, delayMs);
        return;
      }

      stopProgressLoop();
      deps.onEnded();
    };

    currentPlaybackSource = source;
    playbackStartTime = ctx.currentTime;
    playbackDurationSeconds = buffer.duration;

    source.start();
    // Idempotent restart: a prior pass's loop may already have wound down to
    // progressRaf === null (ratio hit 1), or may still have a frame pending —
    // either way this guarantees exactly one loop is driving the bar.
    stopProgressLoop();
    startProgressLoop();
  }

  // Entry point for the speed < 1.0 path. Encodes the clip once per playback
  // (not once per loop pass — see playMediaPass) and hands it to the reused
  // <audio> element via a fresh object URL, revoking the previous one so a
  // multi-minute clip doesn't leak tens of MB per replay.
  function startMediaPlayback(samples: Float32Array, myPlaybackGen: number): void {
    const ctx = deps.audioCtx;

    const audioEl = ensureMediaElement();
    const clipDurationSeconds = samples.length / ctx.sampleRate;

    const blob = encodeWavBlob(samples, ctx.sampleRate);
    const url = URL.createObjectURL(blob);
    if (mediaBlobUrl) URL.revokeObjectURL(mediaBlobUrl);
    mediaBlobUrl = url;
    audioEl.src = url;

    playMediaPass(audioEl, clipDurationSeconds, myPlaybackGen);
  }

  // Plays one pass of `audioEl` (already loaded with the clip) at the current
  // `speed`. Mirrors playBuffer's structure and contract as closely as
  // possible: same generation guard, same "read `looping` fresh at the
  // boundary" restart, same progress-loop bookkeeping — just driving an
  // HTMLMediaElement instead of an AudioBufferSourceNode, since that's the
  // only thing that gets us native pitch-preserving time-stretch.
  function playMediaPass(audioEl: HTMLAudioElement, clipDurationSeconds: number, myPlaybackGen: number): void {
    const ctx = deps.audioCtx;

    audioEl.playbackRate = deps.getSpeed();
    audioEl.preservesPitch = true;
    // Legacy aliases some browsers used before the property was standardized.
    if ('webkitPreservesPitch' in audioEl) (audioEl as LegacyPreservesPitch).webkitPreservesPitch = true;
    if ('mozPreservesPitch' in audioEl) (audioEl as LegacyPreservesPitch).mozPreservesPitch = true;

    audioEl.onended = () => {
      // Same supersede guard as playBuffer's onended — an `ended` event
      // arriving after the user hit Esc (or re-triggered, or changed speed)
      // must not fire a mode transition for a playback that's no longer live.
      if (myPlaybackGen !== playbackGeneration) return;
      currentPlaybackSource = null;

      if (looping) {
        const delayMs = Math.max(0, MIN_LOOP_PASS_SECONDS - playbackDurationSeconds) * 1000;
        setTimeout(() => {
          if (myPlaybackGen !== playbackGeneration) return;
          if (!looping) {
            stopProgressLoop();
            deps.onEnded();
            return;
          }
          playMediaPass(audioEl, clipDurationSeconds, myPlaybackGen);
        }, delayMs);
        return;
      }

      stopProgressLoop();
      deps.onEnded();
    };

    currentPlaybackSource = audioEl;
    mediaClipSeconds = clipDurationSeconds;
    playbackStartTime = ctx.currentTime;
    // Wall-clock duration at this speed — audioEl.duration isn't reliably
    // available synchronously (metadata loads async even for an in-memory
    // blob), so it's derived from the sample count computed up front instead.
    playbackDurationSeconds = clipDurationSeconds / deps.getSpeed();

    audioEl.currentTime = 0;
    const playPromise = audioEl.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch((err: unknown) => {
        if (myPlaybackGen !== playbackGeneration) return;
        console.error('quick-replay: media playback failed', err);
      });
    }

    // Idempotent restart, same reasoning as playBuffer's.
    stopProgressLoop();
    startProgressLoop();
  }

  function setLooping(value: boolean): void {
    looping = value;
    try { localStorage.setItem(LOOP_STORAGE_KEY, looping ? '1' : '0'); } catch { /* ignore */ }
  }

  function stopPlayback(): void {
    playbackGeneration++; // supersede — any pending onended becomes a no-op
    if (currentPlaybackSource) {
      if (currentPlaybackSource instanceof HTMLAudioElement) {
        // Media-element path: pause and rewind rather than stop/disconnect —
        // the element and its MediaElementAudioSourceNode are reused across
        // every slowed playback, not torn down per-play.
        const mediaSource = currentPlaybackSource;
        try { mediaSource.pause(); } catch { /* ignore */ }
        try { mediaSource.currentTime = 0; } catch { /* ignore */ }
      } else {
        const bufferSource = currentPlaybackSource;
        try { bufferSource.stop(); } catch { /* already stopped */ }
        try { bufferSource.disconnect(); } catch { /* ignore */ }
      }
    }
    currentPlaybackSource = null;
    stopProgressLoop();
    renderPlaybackProgress(0);
  }

  // Change the rate of a running media-element playback without restarting it.
  function retuneMediaSpeed(): void {
    if (!mediaAudioEl || mediaClipSeconds <= 0) return;
    const ctx = deps.audioCtx;

    const progress = Math.min(1, Math.max(0, mediaAudioEl.currentTime / mediaClipSeconds));
    mediaAudioEl.playbackRate = deps.getSpeed();

    // The progress bar measures wall-clock elapsed against total wall-clock
    // duration, and both just changed. Re-base so the bar continues from where
    // it is instead of jumping.
    playbackDurationSeconds = mediaClipSeconds / deps.getSpeed();
    playbackStartTime = ctx.currentTime - progress * playbackDurationSeconds;
  }

  return {
    start: startPlayback,
    stop: stopPlayback,
    retuneSpeed: retuneMediaSpeed,
    get isStretching(): boolean {
      return currentPlaybackSource !== null && currentPlaybackSource === mediaAudioEl;
    },
    get span(): PlaybackSpan {
      return { startAbs: playbackSpanStartAbs, endAbs: playbackSpanEndAbs };
    },
    get lastSeconds(): number {
      return lastPlaybackSeconds;
    },
    get lastLabel(): string | null {
      return lastPlaybackLabel;
    },
    get looping(): boolean {
      return looping;
    },
    setLooping,
  };
}
