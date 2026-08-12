// quick-replay browser app.
//
// This module is a thin INTERPRETER over the pure state machine in
// transitions.js: it dispatches events into `reduce()`, then executes the
// returned effects, in order, against the real Web Audio graph. No mode
// logic lives here — only "how do I actually acquire a mic / start capture /
// play a buffer" mechanics.

import { createRingBuffer, type RingBuffer } from './ring-buffer.ts';
import {
  STANDBY, RECORD, PLAYBACK,
  ACQUIRE_MIC, RELEASE_MIC, START_CAPTURE, STOP_CAPTURE, FLUSH,
  START_PLAYBACK, STOP_PLAYBACK,
  initialState, reduce,
  type Mode, type Effect, type Event, type State,
} from './transitions.ts';
import type { RecorderCommand, RecorderAudioMessage } from './audio-messages.ts';
import { DURATIONS, MAX_SECONDS, MIC_CONSTRAINTS } from './config.ts';
import { formatMinSec, formatSpeed } from './format.ts';
import { encodeWavBlob } from './wav.ts';
import { createTakeTracker, type TakeTracker } from './takes.ts';
import { el, flashMessage, messageOf, showArmError, showRuntimeError, setFocusBannerVisible } from './dom.ts';
import { createTimeline, type TimelineModel } from './timeline.ts';
import { createGainControl } from './gain.ts';
import { createSpeedControl, SPEED_MAX } from './speed.ts';

// --- module-level audio state ------------------------------------------

let audioCtx: AudioContext | null = null;
let ringBuffer: RingBuffer | null = null;
let takeTracker: TakeTracker | null = null;
let armed = false;

let mediaStream: MediaStream | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;
let workletNode: AudioWorkletNode | null = null;
let gainNode: GainNode | null = null;
let micHeld = false;

let reducerState: State = initialState();
let generation = 0; // bumped on every dispatched event; guards async races

// Level meter
let latestPeak = 0;
let displayedLevel = 0;
let levelRaf: number | null = null;

// Playback
let currentPlaybackSource: AudioBufferSourceNode | HTMLAudioElement | null = null;
let playbackGeneration = 0; // bumped whenever a playback source is superseded
let playbackStartTime = 0;
let playbackDurationSeconds = 0;
let lastPlaybackSeconds = 0;
let lastPlaybackLabel: string | null = null;
let pendingPlaybackLabel: string | null = null;
let playbackSpanStartAbs = 0;
let playbackSpanEndAbs = 0;
let progressRaf: number | null = null;

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

let looping = loadStoredLooping();

// The media-element playback path (speed < 1.0 only). Created lazily, once,
// on first use — createMediaElementSource() throws if called twice on the
// same element, and a fresh element+node per playback would leak nodes.
// Every subsequent slowed playback just swaps `src` on the same element.
let mediaAudioEl: HTMLAudioElement | null = null;
let mediaSourceNode: MediaElementAudioSourceNode | null = null;
let mediaBlobUrl: string | null = null; // previous blob: URL, so it can be revoked before replacing
let mediaClipSeconds = 0; // clip length in clip-time, for re-basing on a live rate change

// --- level meter ---------------------------------------------------------

const LEVEL_DECAY = 0.85; // per animation frame, ~60fps

function updateLevelMeterFromWorklet(peak: number): void {
  if (peak > latestPeak) latestPeak = peak;
}

function levelMeterTick(): void {
  displayedLevel = Math.max(latestPeak, displayedLevel * LEVEL_DECAY);
  latestPeak = 0;
  renderLevelMeter(displayedLevel);

  if (reducerState.mode === RECORD) {
    levelRaf = requestAnimationFrame(levelMeterTick);
  } else {
    // One last decay-to-zero frame, then stop.
    levelRaf = null;
    renderLevelMeter(0);
  }
}

function startLevelMeterLoop(): void {
  if (levelRaf == null) {
    levelRaf = requestAnimationFrame(levelMeterTick);
  }
}

function renderLevelMeter(level: number): void {
  if (!el.levelMeterFill) return;
  const pct = Math.min(100, Math.max(0, level * 100));
  el.levelMeterFill.style.width = `${pct}%`;
}

// --- playback progress loop ----------------------------------------------

function startProgressLoop(): void {
  function tick(): void {
    if (!currentPlaybackSource || !audioCtx) return;
    const elapsed = audioCtx.currentTime - playbackStartTime;
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

// --- mic lifecycle ---------------------------------------------------------

// Whether the app currently wants to be holding a mic. Playback deliberately
// holds the stream when it came from Record, so returning is gapless.
function micIsWanted(): boolean {
  const { mode, previousMode } = reducerState;
  return mode === RECORD || (mode === PLAYBACK && previousMode === RECORD);
}

async function acquireMic(): Promise<void> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
  } catch (err) {
    const detail = messageOf(err);
    showRuntimeError(`Microphone access failed: ${detail || err}`);
    throw err;
  }

  // Guard on *intent*, not on a bare event counter. Something may have
  // superseded us during the ~100-300ms getUserMedia takes — but pressing
  // `r` twice also bumps that counter, and must not strand us in Record
  // with no mic. `micHeld` catches a concurrent acquire winning the race.
  if (!micIsWanted() || micHeld) {
    stream.getTracks().forEach((track) => track.stop());
    return;
  }

  // Only reachable once armed (dispatch() gates on `armed`, which is only
  // set after audioCtx/ringBuffer are created), so this can never actually
  // be null here — but the compiler can't see that invariant.
  if (!audioCtx || !ringBuffer) return;
  const ctx = audioCtx;
  const buffer = ringBuffer;
  const tracker = takeTracker;

  mediaStream = stream;
  sourceNode = ctx.createMediaStreamSource(stream);
  workletNode = new AudioWorkletNode(ctx, 'recorder');
  workletNode.port.onmessage = (event: MessageEvent<RecorderAudioMessage>) => {
    const data = event.data;
    if (!data || data.type !== 'audio') return;
    const startAbs = buffer.totalWritten;
    buffer.write(data.samples);
    tracker?.noteCapturedFrames(startAbs, buffer.totalWritten);
    updateLevelMeterFromWorklet(data.peak);
  };
  gainNode = ctx.createGain();
  gainNode.gain.value = 0;

  // source -> worklet -> gain(0) -> destination. The zero-gain path to
  // destination is required for the worklet to reliably be pulled, and
  // gain 0 prevents monitoring feedback.
  sourceNode.connect(workletNode);
  workletNode.connect(gainNode);
  gainNode.connect(ctx.destination);

  micHeld = true;
}

function releaseMic(): void {
  // Must be idempotent: the reducer emits this even when no mic is held.
  if (!micHeld && !mediaStream) return;

  // Stop the tracks first and synchronously — this is the privacy-critical
  // step, and what actually darkens the OS mic indicator.
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
  }
  try { sourceNode && sourceNode.disconnect(); } catch { /* ignore */ }

  // A `flush` posted immediately before this (the reducer always emits
  // stopCapture -> flush -> releaseMic) round-trips through the audio
  // thread, so tearing the worklet down synchronously would discard the
  // very tail it exists to preserve. Keep it alive briefly so that last
  // <=85ms still lands in the ring buffer.
  const pendingWorklet = workletNode;
  const pendingGain = gainNode;
  setTimeout(() => {
    try { if (pendingWorklet) pendingWorklet.port.onmessage = null; } catch { /* ignore */ }
    try { if (pendingWorklet) pendingWorklet.disconnect(); } catch { /* ignore */ }
    try { if (pendingGain) pendingGain.disconnect(); } catch { /* ignore */ }
  }, 100);

  sourceNode = null;
  workletNode = null;
  gainNode = null;
  mediaStream = null;
  micHeld = false;
}

function startCapture(): void {
  // A dispatch that awaited getUserMedia can land here after a later event
  // has moved us out of Record; never enable capture outside Record, or we'd
  // record during playback and feed the speakers back into the mic.
  if (reducerState.mode !== RECORD) return;
  // Every entry into Record begins a new take, including the return from a
  // playback — that discontinuity is exactly what the markers exist to show.
  takeTracker?.beginNewTake();
  if (workletNode) {
    const command: RecorderCommand = { type: 'recording', value: true };
    workletNode.port.postMessage(command);
  }
  startLevelMeterLoop();
}

function stopCapture(): void {
  if (workletNode) {
    const command: RecorderCommand = { type: 'recording', value: false };
    workletNode.port.postMessage(command);
  }
}

function flush(): void {
  if (workletNode) {
    const command: RecorderCommand = { type: 'flush' };
    workletNode.port.postMessage(command);
  }
}

// --- timeline model ----------------------------------------------------------

// Snapshot the renderer draws from. All positions are absolute frames; the
// view window is [nowAbs - capacity, nowAbs], so "now" sits at the right edge
// and everything scrolls leftward as recording continues.
function getTimelineModel(): TimelineModel | null {
  if (!ringBuffer || !audioCtx || !takeTracker) return null;
  const nowAbs = ringBuffer.totalWritten;
  const capacity = ringBuffer.capacity;
  return {
    sampleRate: audioCtx.sampleRate,
    maxSeconds: MAX_SECONDS,
    capacity,
    nowAbs,
    windowStartAbs: nowAbs - capacity,
    oldestAbs: nowAbs - ringBuffer.available,
    takes: takeTracker.takes,
    activeTake: reducerState.mode === RECORD ? takeTracker.currentTake : null,
    durations: DURATIONS,
  };
}

// Creates the reused <audio> element and its MediaElementAudioSourceNode
// exactly once, wiring it into the same gain node every AudioBufferSourceNode
// also goes through, so the gain slider applies either way. Must never be
// called more than once per element instance — see the module-level comment
// on `mediaAudioEl`.
function ensureMediaElement(): HTMLAudioElement {
  if (mediaAudioEl) return mediaAudioEl;
  // Only reachable once armed, same invariant as acquireMic — audioCtx is
  // always set by the time any playback path runs.
  if (!audioCtx) throw new Error('quick-replay: ensureMediaElement called before arming');
  const ctx = audioCtx;
  mediaAudioEl = new Audio();
  mediaAudioEl.preload = 'auto';
  mediaSourceNode = ctx.createMediaElementSource(mediaAudioEl);
  mediaSourceNode.connect(gainControl.node || ctx.destination);
  return mediaAudioEl;
}

// --- playback --------------------------------------------------------------

function startPlayback(seconds: number): void {
  // Only reachable once armed, via the START_PLAYBACK effect.
  if (!audioCtx || !ringBuffer) return;
  const ctx = audioCtx;
  const buf = ringBuffer;

  const frames = Math.floor(seconds * ctx.sampleRate);
  const samples = buf.readLast(frames);
  // Which stretch of the buffer this replay is drawn from, in absolute frame
  // positions so the timeline can light it up. Captured here rather than
  // derived at render time because readLast may have returned fewer frames
  // than asked for, and the span must reflect what is actually being heard.
  playbackSpanEndAbs = buf.totalWritten;
  playbackSpanStartAbs = playbackSpanEndAbs - samples.length;
  lastPlaybackSeconds = seconds;
  lastPlaybackLabel = pendingPlaybackLabel;
  pendingPlaybackLabel = null;

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
      dispatch({ type: 'playbackEnded' });
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
  gainControl.setMaterialPeak(peak);

  // At 1.0x, the existing zero-latency AudioBufferSourceNode path is
  // untouched. Only below 1.0 do we pay for the WAV-encode + media-element
  // detour required to get pitch-preserving slowdown.
  if (speedControl.value < 1) {
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
  if (!audioCtx) return;
  const ctx = audioCtx;

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(gainControl.node || ctx.destination);

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
          dispatch({ type: 'playbackEnded' });
          return;
        }
        playBuffer(buffer, myPlaybackGen);
      }, delayMs);
      return;
    }

    stopProgressLoop();
    dispatch({ type: 'playbackEnded' });
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
  if (!audioCtx) return;
  const ctx = audioCtx;

  const audioEl = ensureMediaElement();
  const clipDurationSeconds = samples.length / ctx.sampleRate;

  const blob = encodeWavBlob(samples, ctx.sampleRate);
  const url = URL.createObjectURL(blob);
  if (mediaBlobUrl) URL.revokeObjectURL(mediaBlobUrl);
  mediaBlobUrl = url;
  audioEl.src = url;

  playMediaPass(audioEl, clipDurationSeconds, myPlaybackGen);
}

// Legacy aliases some browsers used before `preservesPitch` was
// standardized. Not part of the DOM lib's HTMLMediaElement typings.
interface LegacyPreservesPitch {
  webkitPreservesPitch?: boolean;
  mozPreservesPitch?: boolean;
}

// Plays one pass of `audioEl` (already loaded with the clip) at the current
// `speed`. Mirrors playBuffer's structure and contract as closely as
// possible: same generation guard, same "read `looping` fresh at the
// boundary" restart, same progress-loop bookkeeping — just driving an
// HTMLMediaElement instead of an AudioBufferSourceNode, since that's the
// only thing that gets us native pitch-preserving time-stretch.
function playMediaPass(audioEl: HTMLAudioElement, clipDurationSeconds: number, myPlaybackGen: number): void {
  if (!audioCtx) return;
  const ctx = audioCtx;

  audioEl.playbackRate = speedControl.value;
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
          dispatch({ type: 'playbackEnded' });
          return;
        }
        playMediaPass(audioEl, clipDurationSeconds, myPlaybackGen);
      }, delayMs);
      return;
    }

    stopProgressLoop();
    dispatch({ type: 'playbackEnded' });
  };

  currentPlaybackSource = audioEl;
  mediaClipSeconds = clipDurationSeconds;
  playbackStartTime = ctx.currentTime;
  // Wall-clock duration at this speed — audioEl.duration isn't reliably
  // available synchronously (metadata loads async even for an in-memory
  // blob), so it's derived from the sample count computed up front instead.
  playbackDurationSeconds = clipDurationSeconds / speedControl.value;

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
  render();
}

function toggleLooping(): void {
  setLooping(!looping);
  flashMessage(looping ? 'looping on' : 'looping off');
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
  if (!mediaAudioEl || mediaClipSeconds <= 0 || !audioCtx) return;
  const ctx = audioCtx;

  const progress = Math.min(1, Math.max(0, mediaAudioEl.currentTime / mediaClipSeconds));
  mediaAudioEl.playbackRate = speedControl.value;

  // The progress bar measures wall-clock elapsed against total wall-clock
  // duration, and both just changed. Re-base so the bar continues from where
  // it is instead of jumping.
  playbackDurationSeconds = mediaClipSeconds / speedControl.value;
  playbackStartTime = ctx.currentTime - progress * playbackDurationSeconds;
}

// --- effect interpreter ------------------------------------------------

async function runEffect(eff: Effect): Promise<void> {
  switch (eff.type) {
    case ACQUIRE_MIC:
      await acquireMic();
      break;
    case RELEASE_MIC:
      releaseMic();
      break;
    case START_CAPTURE:
      startCapture();
      break;
    case STOP_CAPTURE:
      stopCapture();
      break;
    case FLUSH:
      flush();
      break;
    case START_PLAYBACK:
      startPlayback(eff.seconds);
      break;
    case STOP_PLAYBACK:
      stopPlayback();
      break;
    default:
      console.warn('quick-replay: unknown effect', eff);
  }
}

async function dispatch(event: Event): Promise<void> {
  if (!armed) return;

  generation++;
  const myGen = generation;

  const { state: newState, effects } = reduce(reducerState, event, { micHeld });
  reducerState = newState;
  render();

  for (const eff of effects) {
    // Only acquireMic awaits, but that await is long enough for another
    // keypress to land. Anything queued behind it belongs to a mode we may
    // have already left, so abandon the rest rather than applying it late.
    if (myGen !== generation) break;
    try {
      await runEffect(eff);
    } catch {
      // getUserMedia failed mid-flight (e.g. permission revoked). We've
      // already optimistically moved reducerState toward `record`; roll
      // back to standby rather than strand the UI in a mode with no mic.
      if (eff.type === ACQUIRE_MIC) {
        reducerState = { mode: STANDBY, previousMode: reducerState.previousMode };
      }
      break;
    }
  }

  render();
}

function dispatchDuration(seconds: number, label: string | null = null): void {
  if (!ringBuffer || ringBuffer.available === 0) {
    flashMessage('nothing recorded yet');
    return;
  }
  pendingPlaybackLabel = label;
  dispatch({ type: 'duration', seconds });
}

// `q` — replay the current take from its start, or from as far back as the
// buffer still holds if it has already been partly overwritten.
function replayCurrentTake(): void {
  const takeWindow = takeTracker ? takeTracker.currentTakeWindow() : null;
  if (!takeWindow || !audioCtx) {
    flashMessage('nothing recorded yet');
    return;
  }
  const seconds = takeWindow.frames / audioCtx.sampleRate;
  const label = takeWindow.trimmed
    ? `take (${formatMinSec(seconds)}, trimmed to buffer)`
    : `take (${formatMinSec(seconds)})`;
  dispatchDuration(seconds, label);
}

// --- rendering -------------------------------------------------------------

function modeLabelText(mode: Mode): string {
  if (mode === RECORD) return 'Record';
  if (mode === PLAYBACK) return 'Playback';
  return 'Standby';
}

// --- timeline ------------------------------------------------------------

const timeline = createTimeline();

function render(): void {
  if (!el.mainUi) return;

  const mode = reducerState.mode;

  // Mode indicator.
  if (el.modeIndicator) {
    el.modeIndicator.classList.remove('mode-standby', 'mode-record', 'mode-playback');
    el.modeIndicator.classList.add(`mode-${mode}`);
  }
  if (el.modeLabel) {
    el.modeLabel.textContent = modeLabelText(mode);
  }

  // Buffer fill.
  const sampleRate = audioCtx ? audioCtx.sampleRate : 48000;
  const availableSeconds = ringBuffer ? ringBuffer.available / sampleRate : 0;
  if (el.bufferText) {
    el.bufferText.textContent = `${formatMinSec(availableSeconds)} / ${formatMinSec(MAX_SECONDS)}`;
  }
  const timelineModel = getTimelineModel();
  timeline.render(timelineModel);
  const span = reducerState.mode === PLAYBACK
    ? { startAbs: playbackSpanStartAbs, endAbs: playbackSpanEndAbs }
    : null;
  timeline.renderPlaybackSpan(timelineModel, span);

  // Level meter only meaningful while recording.
  if (el.levelMeterContainer) {
    el.levelMeterContainer.classList.toggle('visible', mode === RECORD);
  }

  // Light up the key that launched the running replay, so the button, the
  // key you pressed, and the lit span on the timeline all read as one thing.
  // `q` matches no button, which is correct — it has no fixed duration.
  for (const d of DURATIONS) {
    const btn = document.getElementById(`duration-btn-${d.seconds}`);
    if (!btn) continue;
    const isPlaying = mode === PLAYBACK
      && !lastPlaybackLabel
      && d.seconds === lastPlaybackSeconds;
    btn.classList.toggle('playing', isPlaying);
  }

  // Duration button annotations ("only 2:34" when buffer holds less than
  // the button's duration).
  for (const d of DURATIONS) {
    const annotation = document.getElementById(`duration-annotation-${d.seconds}`);
    if (!annotation) continue;
    if (availableSeconds > 0 && availableSeconds < d.seconds) {
      annotation.textContent = `only ${formatMinSec(availableSeconds)}`;
      annotation.classList.add('visible');
    } else {
      annotation.textContent = '';
      annotation.classList.remove('visible');
    }
  }

  // Playback status line.
  if (el.playbackStatus) {
    el.playbackStatus.classList.toggle('visible', mode === PLAYBACK);
  }
  if (mode === PLAYBACK && el.playbackStatusText) {
    const durationLabel = DURATIONS.find((d) => d.seconds === lastPlaybackSeconds);
    const label = lastPlaybackLabel
      || (durationLabel ? durationLabel.label : formatMinSec(lastPlaybackSeconds));
    // Slowdown is otherwise invisible in this line, so make it explicit at a
    // glance whenever a replay is actually running below full speed.
    const speedSuffix = speedControl.value < 1 ? ` at ${formatSpeed(speedControl.value)} (pitch preserved)` : '';
    if (looping) {
      el.playbackStatusText.textContent = `looping last ${label}${speedSuffix} (L to stop)`;
    } else {
      const target = modeLabelText(reducerState.previousMode);
      el.playbackStatusText.textContent = `playing last ${label}${speedSuffix} → returning to ${target}`;
    }
  }

  // Looping toggle.
  if (el.loopToggle) {
    el.loopToggle.textContent = looping ? 'On' : 'Off';
    el.loopToggle.classList.toggle('on', looping);
    el.loopToggle.setAttribute('aria-pressed', String(looping));
  }

  // Speed readout: call out visually whenever it's below full speed, not
  // just in the playback status line (which only shows while playing).
  if (el.speedValue) {
    el.speedValue.classList.toggle('slowed', speedControl.value < 1);
  }
}

// --- keyboard ----------------------------------------------------------

window.addEventListener('keydown', (event: KeyboardEvent) => {
  if (!armed) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.repeat) return;

  const key = event.key;

  if (key >= '1' && key <= '6') {
    const dur = DURATIONS.find((d) => d.key === key);
    if (dur) {
      event.preventDefault();
      dispatchDuration(dur.seconds);
    }
    return;
  }

  if (key === ' ' || event.code === 'Space') {
    event.preventDefault();
    dispatch({ type: 'back' });
    return;
  }

  if (key === 'Escape') {
    dispatch({ type: 'escape' });
    return;
  }

  // When a slider itself has focus, let its native arrow handling run and
  // let the `input` event carry the change — otherwise we'd apply ±1 dB
  // twice for gain, or double-adjust the speed slider's own value.
  const sliderFocused = document.activeElement === el.gainSlider
    || document.activeElement === el.speedSlider;

  if (!sliderFocused && (key === 'ArrowUp' || key === 'ArrowDown')) {
    event.preventDefault();
    gainControl.nudge(key === 'ArrowUp' ? 1 : -1);
    return;
  }

  if (key === '0') {
    event.preventDefault();
    gainControl.reset();
    flashMessage('volume reset to 0 dB');
    return;
  }

  const lower = key.toLowerCase();
  if (lower === 'q') {
    event.preventDefault();
    replayCurrentTake();
    return;
  }
  if (lower === 'r') {
    dispatch({ type: 'mode', to: RECORD });
    return;
  }
  if (lower === 's') {
    dispatch({ type: 'mode', to: STANDBY });
    return;
  }
  if (lower === 'l') {
    event.preventDefault();
    toggleLooping();
    return;
  }
  if (lower === 'x') {
    event.preventDefault();
    speedControl.cycle();
    return;
  }
});

// --- mouse (fallback) -------------------------------------------------

for (const d of DURATIONS) {
  const btn = document.getElementById(`duration-btn-${d.seconds}`);
  if (btn) {
    btn.addEventListener('click', () => dispatchDuration(d.seconds));
    btn.addEventListener('mouseenter', () => timeline.highlightDurationSpan(getTimelineModel(), d.seconds));
    btn.addEventListener('mouseleave', () => timeline.hideHighlight());
  }
}

if (el.loopToggle) {
  el.loopToggle.addEventListener('click', () => {
    if (!armed) return;
    toggleLooping();
  });
}

// --- gain control ------------------------------------------------------------

const gainControl = createGainControl();

// --- speed control -------------------------------------------------------------

const speedControl = createSpeedControl(() => {
  if (reducerState.mode !== PLAYBACK) return;

  // Already stretching and staying stretched: retune in place. The browser's
  // stretcher follows playbackRate live, so a restart would be gratuitous --
  // and restarting means re-encoding the clip to WAV, which for a 5-minute
  // take is ~14M samples re-serialised on every tick of a slider drag.
  if (currentPlaybackSource === mediaAudioEl && mediaAudioEl && speedControl.value < SPEED_MAX) {
    retuneMediaSpeed();
    return;
  }

  // Crossing the 1.0 boundary swaps time-stretch engines (buffer source vs
  // media element), which genuinely does need a restart. Reuse the exact
  // re-trigger path a repeated duration keypress takes (handleDuration's
  // PLAYBACK branch), so it goes through the supersede guard, not around it.
  pendingPlaybackLabel = lastPlaybackLabel;
  dispatch({ type: 'duration', seconds: lastPlaybackSeconds });
});

// --- focus warning -------------------------------------------------------

window.addEventListener('blur', () => setFocusBannerVisible(true));
window.addEventListener('focus', () => setFocusBannerVisible(false));

// --- unload guard --------------------------------------------------------

window.addEventListener('beforeunload', (event: BeforeUnloadEvent) => {
  if (ringBuffer && ringBuffer.available > 0) {
    event.preventDefault();
    event.returnValue = '';
  }
});

// --- bootstrap -------------------------------------------------------------

if (el.armButton) {
  const armButton = el.armButton;
  armButton.addEventListener('click', async () => {
    armButton.disabled = true;
    if (el.armError) el.armError.classList.remove('visible');

    try {
      audioCtx = new AudioContext();
      await audioCtx.resume();
      await audioCtx.audioWorklet.addModule('./recorder-worklet.js');

      const capacityFrames = Math.floor(MAX_SECONDS * audioCtx.sampleRate);
      ringBuffer = createRingBuffer(capacityFrames);
      takeTracker = createTakeTracker(ringBuffer);

      gainControl.attach(audioCtx);

      // Trigger the permission prompt once up front, then immediately
      // release — the browser remembers the grant per-origin so later
      // acquires (on 'r') never re-prompt and cost near-zero latency.
      const probeStream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
      probeStream.getTracks().forEach((track) => track.stop());

      armed = true;
      reducerState = initialState();

      if (el.armScreen) el.armScreen.classList.add('hidden');
      if (el.mainUi) el.mainUi.classList.remove('hidden');

      render();
    } catch (err) {
      showArmError(err);
      armButton.disabled = false;
    }
  });
}

// Periodic light re-render so the buffer-fill readout / duration
// annotations keep advancing even between worklet messages or effects.
setInterval(() => {
  if (armed) render();
}, 250);
