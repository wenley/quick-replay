// quick-replay browser app.
//
// This module is a thin INTERPRETER over the pure state machine in
// transitions.js: it dispatches events into `reduce()`, then executes the
// returned effects, in order, against the real Web Audio graph. No mode
// logic lives here — only "how do I actually acquire a mic / start capture /
// play a buffer" mechanics.

import { createRingBuffer } from './ring-buffer.js';
import {
  STANDBY, RECORD, PLAYBACK,
  ACQUIRE_MIC, RELEASE_MIC, START_CAPTURE, STOP_CAPTURE, FLUSH,
  START_PLAYBACK, STOP_PLAYBACK,
  initialState, reduce,
} from './transitions.js';

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
  bufferBarFill: document.getElementById('buffer-bar-fill'),
  levelMeterContainer: document.getElementById('level-meter-container'),
  levelMeterFill: document.getElementById('level-meter-fill'),
  playbackStatus: document.getElementById('playback-status'),
  playbackStatusText: document.getElementById('playback-status-text'),
  playbackProgressFill: document.getElementById('playback-progress-fill'),
  flashMessage: document.getElementById('flash-message'),
  focusBanner: document.getElementById('focus-banner'),
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

// Playback
let currentPlaybackSource = null;
let playbackGeneration = 0; // bumped whenever a playback source is superseded
let playbackStartTime = 0;
let playbackDurationSeconds = 0;
let lastPlaybackSeconds = 0;
let progressRaf = null;

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
    ringBuffer.write(data.samples);
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

// --- playback --------------------------------------------------------------

function startPlayback(seconds) {
  const frames = Math.floor(seconds * audioCtx.sampleRate);
  const samples = ringBuffer.readLast(frames);
  lastPlaybackSeconds = seconds;

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

  const buffer = audioCtx.createBuffer(1, samples.length, audioCtx.sampleRate);
  buffer.copyToChannel(samples, 0);

  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(audioCtx.destination);

  source.onended = () => {
    // onended fires on manual .stop() too — no-op if this source has since
    // been superseded by a newer playback (re-trigger, back, escape, etc).
    if (myPlaybackGen !== playbackGeneration) return;
    stopProgressLoop();
    currentPlaybackSource = null;
    dispatch({ type: 'playbackEnded' });
  };

  currentPlaybackSource = source;
  playbackStartTime = audioCtx.currentTime;
  playbackDurationSeconds = samples.length / audioCtx.sampleRate;

  source.start();
  startProgressLoop();
}

function stopPlayback() {
  playbackGeneration++; // supersede — any pending onended becomes a no-op
  if (currentPlaybackSource) {
    try { currentPlaybackSource.stop(); } catch { /* already stopped */ }
    try { currentPlaybackSource.disconnect(); } catch { /* ignore */ }
  }
  currentPlaybackSource = null;
  stopProgressLoop();
  renderPlaybackProgress(0);
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

function dispatchDuration(seconds) {
  if (!ringBuffer || ringBuffer.available === 0) {
    flashMessage('nothing recorded yet');
    return;
  }
  dispatch({ type: 'duration', seconds });
}

// --- rendering -------------------------------------------------------------

function modeLabelText(mode) {
  if (mode === RECORD) return 'Record';
  if (mode === PLAYBACK) return 'Playback';
  return 'Standby';
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
  if (el.bufferBarFill) {
    const pct = MAX_SECONDS > 0 ? Math.min(100, (availableSeconds / MAX_SECONDS) * 100) : 0;
    el.bufferBarFill.style.width = `${pct}%`;
  }

  // Level meter only meaningful while recording.
  if (el.levelMeterContainer) {
    el.levelMeterContainer.classList.toggle('visible', mode === RECORD);
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
    const label = durationLabel ? durationLabel.label : `${lastPlaybackSeconds}s`;
    const target = modeLabelText(reducerState.previousMode);
    el.playbackStatusText.textContent = `playing last ${label} → returning to ${target}`;
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

  const lower = key.toLowerCase();
  if (lower === 'r') {
    dispatch({ type: 'mode', to: RECORD });
    return;
  }
  if (lower === 's') {
    dispatch({ type: 'mode', to: STANDBY });
    return;
  }
});

// --- mouse (fallback) -------------------------------------------------

for (const d of DURATIONS) {
  const btn = document.getElementById(`duration-btn-${d.seconds}`);
  if (btn) {
    btn.addEventListener('click', () => dispatchDuration(d.seconds));
  }
}

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
