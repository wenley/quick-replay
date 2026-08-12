// quick-replay browser app.
//
// This module is a thin INTERPRETER over the pure state machine in
// transitions.js: it dispatches events into `reduce()`, then executes the
// returned effects, in order, against the real Web Audio graph. No mode
// logic lives here — only "how do I actually acquire a mic / start capture /
// play a buffer" mechanics.

import { createRingBuffer } from './js/ring-buffer.js';
import {
  STANDBY, RECORD, PLAYBACK,
  ACQUIRE_MIC, RELEASE_MIC, START_CAPTURE, STOP_CAPTURE, FLUSH,
  START_PLAYBACK, STOP_PLAYBACK,
  initialState, reduce,
} from './js/transitions.js';

// --- config ------------------------------------------------------------

const DURATIONS = [
  { key: '1', seconds: 5, label: '5s' },
  { key: '2', seconds: 10, label: '10s' },
  { key: '3', seconds: 30, label: '30s' },
  { key: '4', seconds: 60, label: '1m' },
  { key: '5', seconds: 120, label: '2m' },
  { key: '6', seconds: 300, label: '5m' },
];

function readMaxSeconds() {
  const raw = document.body.dataset.maxLookbackSeconds;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.warn(
      `quick-replay: __MAX_LOOKBACK_SECONDS__ placeholder was not substituted ` +
      `(got "${raw}"). This page was probably opened directly instead of via ` +
      `the server. Falling back to 300s.`
    );
    return 300;
  }
  return value;
}

const MAX_SECONDS = readMaxSeconds();

// --- DOM refs ------------------------------------------------------------

const el = {
  armScreen: document.getElementById('arm-screen'),
  armButton: document.getElementById('arm-button'),
  armError: document.getElementById('arm-error'),
  mainUi: document.getElementById('main-ui'),
  modeIndicator: document.getElementById('mode-indicator'),
  modeLabel: document.getElementById('mode-label'),
  bufferText: document.getElementById('buffer-text'),
  timelineTicks: document.getElementById('timeline-ticks'),
  timelineTrack: document.getElementById('timeline-track'),
  timelineAxis: document.getElementById('timeline-axis'),
  timelineHighlight: document.getElementById('timeline-highlight'),
  timelinePlaying: document.getElementById('timeline-playing'),
  levelMeterContainer: document.getElementById('level-meter-container'),
  levelMeterFill: document.getElementById('level-meter-fill'),
  playbackStatus: document.getElementById('playback-status'),
  playbackStatusText: document.getElementById('playback-status-text'),
  playbackProgressFill: document.getElementById('playback-progress-fill'),
  flashMessage: document.getElementById('flash-message'),
  focusBanner: document.getElementById('focus-banner'),
  gainSlider: document.getElementById('gain-slider'),
  gainDb: document.getElementById('gain-db'),
  gainMult: document.getElementById('gain-mult'),
  gainClipWarning: document.getElementById('gain-clip-warning'),
  loopToggle: document.getElementById('loop-toggle'),
  speedSlider: document.getElementById('speed-slider'),
  speedValue: document.getElementById('speed-value'),
};

// --- module-level audio state ------------------------------------------

let audioCtx = null;
let ringBuffer = null;
let armed = false;

let mediaStream = null;
let sourceNode = null;
let workletNode = null;
let gainNode = null;
let micHeld = false;

let reducerState = initialState();
let generation = 0; // bumped on every dispatched event; guards async races

// Level meter
let latestPeak = 0;
let displayedLevel = 0;
let levelRaf = null;

// Takes: contiguous stretches of capture, split whenever Record is left for
// Standby or Playback. Boundaries are stored as ABSOLUTE frame positions
// (ringBuffer.totalWritten), never as offsets into the ring buffer. That is
// what makes them survive wraparound: once the buffer is full and old audio
// starts being overwritten, the markers themselves never move — only the
// retained window slides forward past them, and takes fall off the back.
let takes = [];
let currentTake = null;
let pendingNewTake = false;
let takeCounter = 0; // stable ids, so labels don't renumber as takes are pruned

// Playback gain. Expressed in dB because perceived loudness is logarithmic —
// a linear multiplier slider would waste most of its travel on boost and
// leave almost none for attenuation.
const GAIN_MIN_DB = -30; // treated as mute
const GAIN_MAX_DB = 18;
const GAIN_STORAGE_KEY = 'quick-replay:gain-db';

let gainDb = 0;
let playbackGainNode = null;
let lastPlaybackPeak = 0;

// Playback
let currentPlaybackSource = null;
let playbackGeneration = 0; // bumped whenever a playback source is superseded
let playbackStartTime = 0;
let playbackDurationSeconds = 0;
let lastPlaybackSeconds = 0;
let lastPlaybackLabel = null;
let pendingPlaybackLabel = null;
let playbackSpanStartAbs = 0;
let playbackSpanEndAbs = 0;
let progressRaf = null;

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

function loadStoredLooping() {
  try {
    return localStorage.getItem(LOOP_STORAGE_KEY) === '1';
  } catch { /* private mode / storage disabled — fall through to default */ }
  return false;
}

let looping = loadStoredLooping();

// Pitch-preserving playback slowdown. 1.0 keeps the existing zero-latency
// AudioBufferSourceNode path completely untouched; anything below 1.0 takes
// a separate HTMLMediaElement path instead (see playMediaPass), because
// AudioBufferSourceNode.playbackRate resamples — it would drop the pitch
// along with the speed, which is exactly what pitch-preserving means we
// must not do. Speed never exceeds 1.0; this app never speeds audio up.
// Like looping (and unlike gain), it doesn't need audioCtx to load, so it's
// read from storage eagerly here rather than deferred to arm-time.
const SPEED_STORAGE_KEY = 'quick-replay:speed';
const SPEED_MIN = 0.25;
const SPEED_MAX = 1.0;

function loadStoredSpeed() {
  try {
    const raw = localStorage.getItem(SPEED_STORAGE_KEY);
    const value = Number(raw);
    if (raw !== null && Number.isFinite(value)) {
      return Math.min(SPEED_MAX, Math.max(SPEED_MIN, value));
    }
  } catch { /* private mode / storage disabled — fall through to default */ }
  return 1;
}

let speed = loadStoredSpeed();

// The media-element playback path (speed < 1.0 only). Created lazily, once,
// on first use — createMediaElementSource() throws if called twice on the
// same element, and a fresh element+node per playback would leak nodes.
// Every subsequent slowed playback just swaps `src` on the same element.
let mediaAudioEl = null;
let mediaSourceNode = null;
let mediaBlobUrl = null; // previous blob: URL, so it can be revoked before replacing
let mediaClipSeconds = 0; // clip length in clip-time, for re-basing on a live rate change

// --- small utils ---------------------------------------------------------

function formatMinSec(totalSeconds) {
  const safe = Math.max(0, totalSeconds);
  const m = Math.floor(safe / 60);
  const s = Math.floor(safe % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

let flashTimer = null;
function flashMessage(text) {
  if (!el.flashMessage) return;
  el.flashMessage.textContent = text;
  el.flashMessage.classList.add('visible');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    el.flashMessage.classList.remove('visible');
  }, 2000);
}

function showArmError(err) {
  console.error('quick-replay: arm failed', err);
  if (el.armError) {
    el.armError.textContent = `Failed to start: ${err && err.message ? err.message : err}`;
    el.armError.classList.add('visible');
  }
}

function showRuntimeError(message) {
  console.error('quick-replay:', message);
  flashMessage(message);
}

// --- level meter ---------------------------------------------------------

const LEVEL_DECAY = 0.85; // per animation frame, ~60fps

function updateLevelMeterFromWorklet(peak) {
  if (peak > latestPeak) latestPeak = peak;
}

function levelMeterTick() {
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

function startLevelMeterLoop() {
  if (levelRaf == null) {
    levelRaf = requestAnimationFrame(levelMeterTick);
  }
}

function renderLevelMeter(level) {
  if (!el.levelMeterFill) return;
  const pct = Math.min(100, Math.max(0, level * 100));
  el.levelMeterFill.style.width = `${pct}%`;
}

// --- playback progress loop ----------------------------------------------

function startProgressLoop() {
  function tick() {
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

function stopProgressLoop() {
  if (progressRaf != null) cancelAnimationFrame(progressRaf);
  progressRaf = null;
}

function renderPlaybackProgress(ratio) {
  if (!el.playbackProgressFill) return;
  el.playbackProgressFill.style.width = `${Math.round(ratio * 100)}%`;
}

// --- mic lifecycle ---------------------------------------------------------

const MIC_CONSTRAINTS = {
  audio: {
    echoCancellation: false,
    autoGainControl: false,
    noiseSuppression: false,
    channelCount: 1,
  },
};

// Whether the app currently wants to be holding a mic. Playback deliberately
// holds the stream when it came from Record, so returning is gapless.
function micIsWanted() {
  const { mode, previousMode } = reducerState;
  return mode === RECORD || (mode === PLAYBACK && previousMode === RECORD);
}

async function acquireMic() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
  } catch (err) {
    showRuntimeError(`Microphone access failed: ${err.message || err}`);
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

  mediaStream = stream;
  sourceNode = audioCtx.createMediaStreamSource(stream);
  workletNode = new AudioWorkletNode(audioCtx, 'recorder');
  workletNode.port.onmessage = (event) => {
    const data = event.data;
    if (!data || data.type !== 'audio') return;
    const startAbs = ringBuffer.totalWritten;
    ringBuffer.write(data.samples);
    noteCapturedFrames(startAbs, ringBuffer.totalWritten);
    updateLevelMeterFromWorklet(data.peak);
  };
  gainNode = audioCtx.createGain();
  gainNode.gain.value = 0;

  // source -> worklet -> gain(0) -> destination. The zero-gain path to
  // destination is required for the worklet to reliably be pulled, and
  // gain 0 prevents monitoring feedback.
  sourceNode.connect(workletNode);
  workletNode.connect(gainNode);
  gainNode.connect(audioCtx.destination);

  micHeld = true;
}

function releaseMic() {
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

function startCapture() {
  // A dispatch that awaited getUserMedia can land here after a later event
  // has moved us out of Record; never enable capture outside Record, or we'd
  // record during playback and feed the speakers back into the mic.
  if (reducerState.mode !== RECORD) return;
  // Every entry into Record begins a new take, including the return from a
  // playback — that discontinuity is exactly what the markers exist to show.
  pendingNewTake = true;
  if (workletNode) {
    workletNode.port.postMessage({ type: 'recording', value: true });
  }
  startLevelMeterLoop();
}

function stopCapture() {
  if (workletNode) {
    workletNode.port.postMessage({ type: 'recording', value: false });
  }
}

function flush() {
  if (workletNode) {
    workletNode.port.postMessage({ type: 'flush' });
  }
}

// --- takes -----------------------------------------------------------------

// Called after every batch the worklet delivers. Deriving take boundaries
// from the write stream rather than from the stopCapture effect matters: the
// worklet's flush round-trips through the audio thread, so the final ~85ms of
// a take arrives *after* the transition. Extending the take on write means
// that tail lands inside the take it belongs to instead of just outside it.
function noteCapturedFrames(startAbs, endAbs) {
  if (endAbs <= startAbs) return;

  if (pendingNewTake || !currentTake) {
    currentTake = { id: ++takeCounter, startAbs, endAbs, wallClockStart: Date.now() };
    takes.push(currentTake);
    pendingNewTake = false;
  } else {
    currentTake.endAbs = endAbs;
  }

  pruneTakes();
}

// Drop takes the ring buffer has entirely overwritten, so the list can't grow
// without bound across a long session.
function pruneTakes() {
  const oldestAbs = ringBuffer.totalWritten - ringBuffer.available;
  if (takes.length && takes[0].endAbs <= oldestAbs) {
    takes = takes.filter((t) => t.endAbs > oldestAbs);
    if (currentTake && !takes.includes(currentTake)) currentTake = null;
  }
}

// The most recent take, clamped to what the buffer still holds. Returns null
// when there is nothing replayable.
function currentTakeWindow() {
  if (!ringBuffer || takes.length === 0) return null;
  const take = takes[takes.length - 1];
  const oldestAbs = ringBuffer.totalWritten - ringBuffer.available;
  const startAbs = Math.max(take.startAbs, oldestAbs);
  const frames = ringBuffer.totalWritten - startAbs;
  if (frames <= 0) return null;
  return { startAbs, frames, trimmed: take.startAbs < oldestAbs };
}

// Snapshot the renderer draws from. All positions are absolute frames; the
// view window is [nowAbs - capacity, nowAbs], so "now" sits at the right edge
// and everything scrolls leftward as recording continues.
function getTimelineModel() {
  if (!ringBuffer || !audioCtx) return null;
  const nowAbs = ringBuffer.totalWritten;
  const capacity = ringBuffer.capacity;
  return {
    sampleRate: audioCtx.sampleRate,
    maxSeconds: MAX_SECONDS,
    capacity,
    nowAbs,
    windowStartAbs: nowAbs - capacity,
    oldestAbs: nowAbs - ringBuffer.available,
    takes,
    activeTake: reducerState.mode === RECORD ? currentTake : null,
    durations: DURATIONS,
  };
}

// --- playback gain ---------------------------------------------------------

function dbToLinear(db) {
  // The bottom of the range is a true mute rather than a very quiet signal.
  if (db <= GAIN_MIN_DB) return 0;
  return Math.pow(10, db / 20);
}

function loadStoredGainDb() {
  try {
    const raw = localStorage.getItem(GAIN_STORAGE_KEY);
    const value = Number(raw);
    if (raw !== null && Number.isFinite(value)) {
      return Math.min(GAIN_MAX_DB, Math.max(GAIN_MIN_DB, value));
    }
  } catch { /* private mode / storage disabled — fall through to default */ }
  return 0;
}

function setGainDb(db, { fromSlider = false } = {}) {
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

function renderGain() {
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

// --- WAV encoding (for the media-element slowdown path) --------------------

// Encodes mono Float32 samples as a 16-bit PCM WAV Blob. This exists only so
// the clip can be handed to an <audio> element — HTMLMediaElement is what
// gives us native pitch-preserving time-stretch via `preservesPitch`, and it
// needs a real media resource, not a raw sample array.
function encodeWavBlob(samples, sampleRate) {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  function writeString(offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // format = PCM
  view.setUint16(22, 1, true); // channels = mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true); // byte rate
  view.setUint16(32, bytesPerSample, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, Math.round(clamped * (clamped < 0 ? 32768 : 32767)), true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

// Creates the reused <audio> element and its MediaElementAudioSourceNode
// exactly once, wiring it into the same playbackGainNode every
// AudioBufferSourceNode also goes through, so the gain slider applies either
// way. Must never be called more than once per element instance — see the
// module-level comment on `mediaAudioEl`.
function ensureMediaElement() {
  if (mediaAudioEl) return mediaAudioEl;
  mediaAudioEl = new Audio();
  mediaAudioEl.preload = 'auto';
  mediaSourceNode = audioCtx.createMediaElementSource(mediaAudioEl);
  mediaSourceNode.connect(playbackGainNode || audioCtx.destination);
  return mediaAudioEl;
}

// --- playback --------------------------------------------------------------

function startPlayback(seconds) {
  const frames = Math.floor(seconds * audioCtx.sampleRate);
  const samples = ringBuffer.readLast(frames);
  // Which stretch of the buffer this replay is drawn from, in absolute frame
  // positions so the timeline can light it up. Captured here rather than
  // derived at render time because readLast may have returned fewer frames
  // than asked for, and the span must reflect what is actually being heard.
  playbackSpanEndAbs = ringBuffer.totalWritten;
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
  lastPlaybackPeak = peak;
  renderGain();

  // At 1.0x, the existing zero-latency AudioBufferSourceNode path is
  // untouched. Only below 1.0 do we pay for the WAV-encode + media-element
  // detour required to get pitch-preserving slowdown.
  if (speed < 1) {
    startMediaPlayback(samples, myPlaybackGen);
    return;
  }

  const buffer = audioCtx.createBuffer(1, samples.length, audioCtx.sampleRate);
  buffer.copyToChannel(samples, 0);

  playBuffer(buffer, myPlaybackGen);
}

// Plays one pass of `buffer` through playbackGainNode. Used both for the
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
function playBuffer(buffer, myPlaybackGen) {
  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(playbackGainNode || audioCtx.destination);

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
  playbackStartTime = audioCtx.currentTime;
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
function startMediaPlayback(samples, myPlaybackGen) {
  const audioEl = ensureMediaElement();
  const clipDurationSeconds = samples.length / audioCtx.sampleRate;

  const blob = encodeWavBlob(samples, audioCtx.sampleRate);
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
function playMediaPass(audioEl, clipDurationSeconds, myPlaybackGen) {
  audioEl.playbackRate = speed;
  audioEl.preservesPitch = true;
  // Legacy aliases some browsers used before the property was standardized.
  if ('webkitPreservesPitch' in audioEl) audioEl.webkitPreservesPitch = true;
  if ('mozPreservesPitch' in audioEl) audioEl.mozPreservesPitch = true;

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
  playbackStartTime = audioCtx.currentTime;
  // Wall-clock duration at this speed — audioEl.duration isn't reliably
  // available synchronously (metadata loads async even for an in-memory
  // blob), so it's derived from the sample count computed up front instead.
  playbackDurationSeconds = clipDurationSeconds / speed;

  audioEl.currentTime = 0;
  const playPromise = audioEl.play();
  if (playPromise && typeof playPromise.catch === 'function') {
    playPromise.catch((err) => {
      if (myPlaybackGen !== playbackGeneration) return;
      console.error('quick-replay: media playback failed', err);
    });
  }

  // Idempotent restart, same reasoning as playBuffer's.
  stopProgressLoop();
  startProgressLoop();
}

function setLooping(value) {
  looping = value;
  try { localStorage.setItem(LOOP_STORAGE_KEY, looping ? '1' : '0'); } catch { /* ignore */ }
  render();
}

function toggleLooping() {
  setLooping(!looping);
  flashMessage(looping ? 'looping on' : 'looping off');
}

function stopPlayback() {
  playbackGeneration++; // supersede — any pending onended becomes a no-op
  if (currentPlaybackSource) {
    if (currentPlaybackSource === mediaAudioEl) {
      // Media-element path: pause and rewind rather than stop/disconnect —
      // the element and its MediaElementAudioSourceNode are reused across
      // every slowed playback, not torn down per-play.
      try { currentPlaybackSource.pause(); } catch { /* ignore */ }
      try { currentPlaybackSource.currentTime = 0; } catch { /* ignore */ }
    } else {
      try { currentPlaybackSource.stop(); } catch { /* already stopped */ }
      try { currentPlaybackSource.disconnect(); } catch { /* ignore */ }
    }
  }
  currentPlaybackSource = null;
  stopProgressLoop();
  renderPlaybackProgress(0);
}

function formatSpeed(value) {
  return `${value.toFixed(2)}x`;
}

function renderSpeed() {
  if (el.speedValue) el.speedValue.textContent = formatSpeed(speed);
}

function setSpeed(newSpeed, { fromSlider = false } = {}) {
  const clamped = Math.min(SPEED_MAX, Math.max(SPEED_MIN, newSpeed));
  const changed = Math.abs(clamped - speed) > 1e-9;
  speed = clamped;

  try { localStorage.setItem(SPEED_STORAGE_KEY, String(speed)); } catch { /* ignore */ }

  if (!fromSlider && el.speedSlider) el.speedSlider.value = String(speed);
  renderSpeed();

  if (!changed || reducerState.mode !== PLAYBACK) return;

  // Already stretching and staying stretched: retune in place. The browser's
  // stretcher follows playbackRate live, so a restart would be gratuitous --
  // and restarting means re-encoding the clip to WAV, which for a 5-minute
  // take is ~14M samples re-serialised on every tick of a slider drag.
  if (currentPlaybackSource === mediaAudioEl && mediaAudioEl && speed < SPEED_MAX) {
    retuneMediaSpeed();
    return;
  }

  // Crossing the 1.0 boundary swaps time-stretch engines (buffer source vs
  // media element), which genuinely does need a restart. Reuse the exact
  // re-trigger path a repeated duration keypress takes (handleDuration's
  // PLAYBACK branch), so it goes through the supersede guard, not around it.
  pendingPlaybackLabel = lastPlaybackLabel;
  dispatch({ type: 'duration', seconds: lastPlaybackSeconds });
}

// Change the rate of a running media-element playback without restarting it.
function retuneMediaSpeed() {
  if (!mediaAudioEl || mediaClipSeconds <= 0) return;

  const progress = Math.min(1, Math.max(0, mediaAudioEl.currentTime / mediaClipSeconds));
  mediaAudioEl.playbackRate = speed;

  // The progress bar measures wall-clock elapsed against total wall-clock
  // duration, and both just changed. Re-base so the bar continues from where
  // it is instead of jumping.
  playbackDurationSeconds = mediaClipSeconds / speed;
  playbackStartTime = audioCtx.currentTime - progress * playbackDurationSeconds;
}

// `x` — cycles 1.0 -> 0.75 -> 0.5 -> back to 1.0. Steps down from wherever
// the slider currently sits (so an in-between slider value like 0.83 cycles
// to the next step down rather than snapping to a fixed sequence position).
// Steps down through the presets and wraps back to full speed. Includes the
// slider's floor so the keyboard can reach the whole range on its own.
const SPEED_STEPS = [0.75, 0.5, 0.25];

function cycleSpeed() {
  const next = SPEED_STEPS.find((step) => speed > step + 1e-9) ?? SPEED_MAX;
  setSpeed(next);
  flashMessage(`speed ${formatSpeed(next)}`);
}

// --- effect interpreter ------------------------------------------------

async function runEffect(eff) {
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

async function dispatch(event) {
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
    } catch (err) {
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

function dispatchDuration(seconds, label = null) {
  if (!ringBuffer || ringBuffer.available === 0) {
    flashMessage('nothing recorded yet');
    return;
  }
  pendingPlaybackLabel = label;
  dispatch({ type: 'duration', seconds });
}

// `q` — replay the current take from its start, or from as far back as the
// buffer still holds if it has already been partly overwritten.
function replayCurrentTake() {
  const window = currentTakeWindow();
  if (!window) {
    flashMessage('nothing recorded yet');
    return;
  }
  const seconds = window.frames / audioCtx.sampleRate;
  const label = window.trimmed
    ? `take (${formatMinSec(seconds)}, trimmed to buffer)`
    : `take (${formatMinSec(seconds)})`;
  dispatchDuration(seconds, label);
}

// --- rendering -------------------------------------------------------------

function modeLabelText(mode) {
  if (mode === RECORD) return 'Record';
  if (mode === PLAYBACK) return 'Playback';
  return 'Standby';
}

// --- timeline highlight (hover preview) -----------------------------------

function showTimelineHighlight(pct) {
  if (!el.timelineHighlight) return;
  const clamped = Math.min(100, Math.max(0, pct));
  el.timelineHighlight.style.left = `${clamped}%`;
  el.timelineHighlight.style.width = `${100 - clamped}%`;
  el.timelineHighlight.classList.remove('hidden');
}

function hideTimelineHighlight() {
  if (!el.timelineHighlight) return;
  el.timelineHighlight.classList.add('hidden');
}

// Hovering a duration button previews the span of the track it would replay.
function highlightDurationSpan(seconds) {
  const model = getTimelineModel();
  if (!model || model.capacity <= 0) return;
  const targetAbs = model.nowAbs - seconds * model.sampleRate;
  const pct = Math.min(1, Math.max(0, (targetAbs - model.windowStartAbs) / model.capacity)) * 100;
  showTimelineHighlight(pct);
}

// The stretch of buffer the current replay is drawn from. Lives outside
// #timeline-track because renderTimeline() replaces that element's children
// wholesale on every pass.
function renderPlaybackSpan(model) {
  if (!el.timelinePlaying) return;

  if (!model || reducerState.mode !== PLAYBACK || playbackSpanEndAbs <= playbackSpanStartAbs) {
    el.timelinePlaying.classList.add('hidden');
    return;
  }

  const fraction = (abs) =>
    Math.min(1, Math.max(0, (abs - model.windowStartAbs) / model.capacity));
  const startPct = fraction(playbackSpanStartAbs) * 100;
  const endPct = fraction(playbackSpanEndAbs) * 100;

  el.timelinePlaying.style.left = `${startPct}%`;
  el.timelinePlaying.style.width = `${Math.max(0, endPct - startPct)}%`;
  el.timelinePlaying.classList.remove('hidden');
}

// --- timeline (buffer/take visualization) ---------------------------------

// Hover is delegated to the container rather than bound per tick: the ticks
// are rebuilt several times a second while recording, and a node replaced
// mid-hover never fires its own mouseleave, which would strand the highlight.
if (el.timelineTicks) {
  el.timelineTicks.addEventListener('mouseover', (event) => {
    const pct = event.target && event.target.dataset && event.target.dataset.pct;
    if (pct !== undefined && pct !== null && pct !== '') showTimelineHighlight(Number(pct));
  });
  el.timelineTicks.addEventListener('mouseleave', hideTimelineHighlight);
}

const AXIS_INTERVALS_SECONDS = [5, 10, 15, 30, 60, 120, 300];

function pickAxisInterval(maxSeconds) {
  for (const candidate of AXIS_INTERVALS_SECONDS) {
    if (maxSeconds / candidate <= 6) return candidate;
  }
  return AXIS_INTERVALS_SECONDS[AXIS_INTERVALS_SECONDS.length - 1];
}

function renderTimeline(model) {
  if (!el.timelineTicks || !el.timelineTrack || !el.timelineAxis) return;

  if (!model || model.capacity <= 0) {
    el.timelineTicks.replaceChildren();
    el.timelineTrack.replaceChildren();
    el.timelineAxis.replaceChildren();
    hideTimelineHighlight();
    return;
  }

  const fraction = (abs) => {
    const f = (abs - model.windowStartAbs) / model.capacity;
    return Math.min(1, Math.max(0, f));
  };

  // --- reach ticks: "how far back does duration N reach?" ---
  const ticksFrag = document.createDocumentFragment();
  let lastLabelPct = null;
  for (const d of model.durations) {
    const targetAbs = model.nowAbs - d.seconds * model.sampleRate;
    const rawFraction = (targetAbs - model.windowStartAbs) / model.capacity;
    const clipped = rawFraction < 0;
    const pct = Math.min(1, Math.max(0, rawFraction)) * 100;

    const tick = document.createElement('div');
    tick.className = clipped ? 'timeline-tick clipped' : 'timeline-tick';
    tick.style.left = `${pct}%`;
    tick.dataset.pct = String(pct);
    ticksFrag.appendChild(tick);

    if (lastLabelPct === null || Math.abs(pct - lastLabelPct) >= 4) {
      const label = document.createElement('div');
      label.className = clipped ? 'timeline-tick-label clipped' : 'timeline-tick-label';
      label.style.left = `${pct}%`;
      label.textContent = d.key;
      label.dataset.pct = String(pct);
      ticksFrag.appendChild(label);
      lastLabelPct = pct;
    }
  }
  el.timelineTicks.replaceChildren(ticksFrag);

  // --- track: unfilled headroom + one span per take + boundary markers ---
  const trackFrag = document.createDocumentFragment();
  for (const take of model.takes) {
    const clampedStartAbs = Math.max(take.startAbs, model.oldestAbs);
    const startPct = fraction(clampedStartAbs) * 100;
    const endPct = fraction(take.endAbs) * 100;
    const width = Math.max(0, endPct - startPct);
    const isActive = model.activeTake === take;

    const span = document.createElement('div');
    span.className = isActive ? 'timeline-take active' : 'timeline-take';
    span.style.left = `${startPct}%`;
    span.style.width = `${width}%`;
    const takeSeconds = (take.endAbs - take.startAbs) / model.sampleRate;
    const clockStart = new Date(take.wallClockStart).toLocaleTimeString();
    span.title = `Take ${take.id} — ${formatMinSec(takeSeconds)}, started ${clockStart}`;
    trackFrag.appendChild(span);

    // Start marker: only when the true start is still retained (not
    // partially overwritten — that edge is the buffer limit, not a seam).
    if (take.startAbs >= model.oldestAbs) {
      const startMarker = document.createElement('div');
      startMarker.className = 'timeline-boundary';
      startMarker.style.left = `${startPct}%`;
      trackFrag.appendChild(startMarker);
    }
    // End marker: skip on the active take — its end is "now", not a seam.
    if (take !== model.activeTake) {
      const endMarker = document.createElement('div');
      endMarker.className = 'timeline-boundary';
      endMarker.style.left = `${endPct}%`;
      trackFrag.appendChild(endMarker);
    }
  }
  el.timelineTrack.replaceChildren(trackFrag);

  // --- time axis: adaptive interval, "now" right-aligned ---
  const axisFrag = document.createDocumentFragment();
  const interval = pickAxisInterval(model.maxSeconds);
  for (let s = 0; s <= model.maxSeconds; s += interval) {
    const pct = model.maxSeconds > 0 ? (1 - s / model.maxSeconds) * 100 : 100;
    const label = document.createElement('div');
    label.className = 'timeline-axis-label';
    label.style.left = `${pct}%`;
    label.textContent = s === 0 ? 'now' : `-${formatMinSec(s)}`;
    if (pct >= 99.99) {
      label.style.transform = 'translateX(-100%)';
    } else if (pct <= 0.01) {
      label.style.transform = 'translateX(0)';
    } else {
      label.style.transform = 'translateX(-50%)';
    }
    axisFrag.appendChild(label);
  }
  el.timelineAxis.replaceChildren(axisFrag);
}

function render() {
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
  renderTimeline(timelineModel);
  renderPlaybackSpan(timelineModel);

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
    const speedSuffix = speed < 1 ? ` at ${formatSpeed(speed)} (pitch preserved)` : '';
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
    el.speedValue.classList.toggle('slowed', speed < 1);
  }
}

// --- keyboard ----------------------------------------------------------

window.addEventListener('keydown', (event) => {
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
    setGainDb(gainDb + (key === 'ArrowUp' ? 1 : -1));
    return;
  }

  if (key === '0') {
    event.preventDefault();
    setGainDb(0);
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
    cycleSpeed();
    return;
  }
});

// --- mouse (fallback) -------------------------------------------------

for (const d of DURATIONS) {
  const btn = document.getElementById(`duration-btn-${d.seconds}`);
  if (btn) {
    btn.addEventListener('click', () => dispatchDuration(d.seconds));
    btn.addEventListener('mouseenter', () => highlightDurationSpan(d.seconds));
    btn.addEventListener('mouseleave', hideTimelineHighlight);
  }
}

if (el.loopToggle) {
  el.loopToggle.addEventListener('click', () => {
    if (!armed) return;
    toggleLooping();
  });
}

// --- gain slider -----------------------------------------------------------

if (el.gainSlider) {
  el.gainSlider.min = String(GAIN_MIN_DB);
  el.gainSlider.max = String(GAIN_MAX_DB);
  el.gainSlider.addEventListener('input', () => {
    setGainDb(Number(el.gainSlider.value), { fromSlider: true });
  });
  // Hand focus back after a click, so the duration keys keep working without
  // the user having to click away from the slider first.
  el.gainSlider.addEventListener('change', () => el.gainSlider.blur());
}

// --- speed slider ------------------------------------------------------------

if (el.speedSlider) {
  el.speedSlider.min = String(SPEED_MIN);
  el.speedSlider.max = String(SPEED_MAX);
  el.speedSlider.step = '0.01';
  el.speedSlider.value = String(speed);
  el.speedSlider.addEventListener('input', () => {
    setSpeed(Number(el.speedSlider.value), { fromSlider: true });
  });
  // Same reasoning as the gain slider: hand focus back after a click so
  // duration keys keep working without clicking away first.
  el.speedSlider.addEventListener('change', () => el.speedSlider.blur());
}
renderSpeed();

// --- focus warning -------------------------------------------------------

function setFocusBannerVisible(visible) {
  if (!el.focusBanner) return;
  el.focusBanner.classList.toggle('visible', visible);
}

window.addEventListener('blur', () => setFocusBannerVisible(true));
window.addEventListener('focus', () => setFocusBannerVisible(false));

// --- unload guard --------------------------------------------------------

window.addEventListener('beforeunload', (event) => {
  if (ringBuffer && ringBuffer.available > 0) {
    event.preventDefault();
    event.returnValue = '';
  }
});

// --- bootstrap -------------------------------------------------------------

if (el.armButton) {
  el.armButton.addEventListener('click', async () => {
    el.armButton.disabled = true;
    if (el.armError) el.armError.classList.remove('visible');

    try {
      audioCtx = new AudioContext();
      await audioCtx.resume();
      await audioCtx.audioWorklet.addModule('./recorder-worklet.js');

      const capacityFrames = Math.floor(MAX_SECONDS * audioCtx.sampleRate);
      ringBuffer = createRingBuffer(capacityFrames);

      // Persistent node every playback source routes through, so the slider
      // takes effect mid-replay rather than only on the next one.
      playbackGainNode = audioCtx.createGain();
      playbackGainNode.connect(audioCtx.destination);
      setGainDb(loadStoredGainDb());

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
      el.armButton.disabled = false;
    }
  });
}

// Periodic light re-render so the buffer-fill readout / duration
// annotations keep advancing even between worklet messages or effects.
setInterval(() => {
  if (armed) render();
}, 250);
