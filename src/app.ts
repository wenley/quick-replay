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
import { DURATIONS, MAX_SECONDS } from './config.ts';
import { formatMinSec, formatSpeed } from './format.ts';
import { createTakeTracker, type TakeTracker } from './takes.ts';
import { el, flashMessage, showArmError, setFocusBannerVisible, showRuntimeError } from './dom.ts';
import { createTimeline, type TimelineModel } from './timeline.ts';
import { createGainControl } from './gain.ts';
import { createSpeedControl, SPEED_MAX } from './speed.ts';
import { createDevicePicker } from './devices.ts';
import { createCapture, type Capture } from './capture.ts';
import { createPlayback, type Playback } from './playback.ts';
import { reportDiagnostics, installDiagnosticsHook } from './diagnostics.ts';
import { getUserMediaWithRetry, type RetryNotice } from './get-user-media.ts';

// --- module-level audio state ------------------------------------------

let audioCtx: AudioContext | null = null;
let ringBuffer: RingBuffer | null = null;
let takeTracker: TakeTracker | null = null;
let capture: Capture | null = null;
let armed = false;

let reducerState: State = initialState();
let generation = 0; // bumped on every dispatched event; guards async races

// Playback
let playback: Playback | null = null;
// Bridges dispatchDuration/the speed-retune path to the START_PLAYBACK effect,
// which only carries `seconds` — the label rides along here instead.
let pendingPlaybackLabel: string | null = null;

// --- mic lifecycle ---------------------------------------------------------

// Whether the app currently wants to be holding a mic. Playback deliberately
// holds the stream when it came from Record, so returning is gapless.
function micIsWanted(): boolean {
  const { mode, previousMode } = reducerState;
  return mode === RECORD || (mode === PLAYBACK && previousMode === RECORD);
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

// --- effect interpreter ------------------------------------------------

async function runEffect(eff: Effect): Promise<void> {
  switch (eff.type) {
    case ACQUIRE_MIC:
      await capture?.acquire();
      break;
    case RELEASE_MIC:
      capture?.release();
      break;
    case START_CAPTURE:
      capture?.start();
      break;
    case STOP_CAPTURE:
      capture?.stop();
      break;
    case FLUSH:
      capture?.flush();
      break;
    case START_PLAYBACK:
      playback?.start(eff.seconds, pendingPlaybackLabel);
      pendingPlaybackLabel = null;
      break;
    case STOP_PLAYBACK:
      playback?.stop();
      break;
    default:
      console.warn('quick-replay: unknown effect', eff);
  }
}

async function dispatch(event: Event): Promise<void> {
  if (!armed) return;

  generation++;
  const myGen = generation;

  const { state: newState, effects } = reduce(reducerState, event, { micHeld: capture ? capture.micHeld : false });
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
        reducerState = { mode: STANDBY, previousMode: reducerState.previousMode, playbackSource: null };
      }
      break;
    }
  }

  render();
}

function dispatchDuration(seconds: number, label: string | null = null, source: string | null = null): void {
  if (!ringBuffer || ringBuffer.available === 0) {
    flashMessage('nothing recorded yet');
    return;
  }
  pendingPlaybackLabel = label;
  dispatch({ type: 'duration', seconds, source });
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
  dispatchDuration(seconds, label, 'q');
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
  const span = reducerState.mode === PLAYBACK && playback ? playback.span : null;
  timeline.renderPlaybackSpan(timelineModel, span);

  // Level meter only meaningful while recording.
  if (el.levelMeterContainer) {
    el.levelMeterContainer.classList.toggle('visible', mode === RECORD);
  }

  // Light up the key that launched the running replay, so the button, the
  // key you pressed, and the lit span on the timeline all read as one thing.
  // `q` matches no button, which is correct — it has no fixed duration.
  // Compared against the exact trigger that's live (playbackSource) rather
  // than inferred from the current seconds/label, since a re-trigger with
  // the same seconds but a different source (or vice versa) must not
  // mislight a button.
  for (const d of DURATIONS) {
    const btn = document.getElementById(`duration-btn-${d.seconds}`);
    if (!btn) continue;
    const isPlaying = reducerState.playbackSource === d.key;
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
    const lastPlaybackSeconds = playback?.lastSeconds ?? 0;
    const durationLabel = DURATIONS.find((d) => d.seconds === lastPlaybackSeconds);
    const label = playback?.lastLabel
      || (durationLabel ? durationLabel.label : formatMinSec(lastPlaybackSeconds));
    // Slowdown is otherwise invisible in this line, so make it explicit at a
    // glance whenever a replay is actually running below full speed.
    const speedSuffix = speedControl.value < 1 ? ` at ${formatSpeed(speedControl.value)} (pitch preserved)` : '';
    const target = modeLabelText(reducerState.previousMode);
    el.playbackStatusText.textContent = `looping last ${label}${speedSuffix} → Space to return to ${target}`;
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
      dispatchDuration(dur.seconds, null, dur.key);
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
    btn.addEventListener('click', () => dispatchDuration(d.seconds, null, d.key));
    btn.addEventListener('mouseenter', () => timeline.highlightDurationSpan(getTimelineModel(), d.seconds));
    btn.addEventListener('mouseleave', () => timeline.hideHighlight());
  }
}

// --- gain control ------------------------------------------------------------

const gainControl = createGainControl();

// --- speed control -------------------------------------------------------------

const speedControl = createSpeedControl(() => {
  if (reducerState.mode !== PLAYBACK || !playback) return;

  // Already stretching and staying stretched: retune in place. The browser's
  // stretcher follows playbackRate live, so a restart would be gratuitous --
  // and restarting means re-encoding the clip to WAV, which for a 5-minute
  // take is ~14M samples re-serialised on every tick of a slider drag.
  if (playback.isStretching && speedControl.value < SPEED_MAX) {
    playback.retuneSpeed();
    return;
  }

  // Crossing the 1.0 boundary swaps time-stretch engines (buffer source vs
  // media element), which genuinely does need a restart. Reuse the exact
  // re-trigger path a repeated duration keypress takes (handleDuration's
  // PLAYBACK branch), so it goes through the supersede guard, not around it.
  pendingPlaybackLabel = playback.lastLabel;
  dispatch({ type: 'duration', seconds: playback.lastSeconds, source: null });
});

// --- input device ----------------------------------------------------------

const devicePicker = createDevicePicker({ onChange: () => { void switchInputDevice(); } });

// Switching devices while a mic isn't held is a no-op — the next acquire()
// picks up the new constraints on its own. While one IS held, release and
// re-acquire so the change takes effect immediately. Note this means
// switching mid-Record starts a new take, which is correct: it's a genuine
// discontinuity in the audio.
async function switchInputDevice(): Promise<void> {
  if (!capture || !capture.micHeld) return;
  const wasRecording = reducerState.mode === RECORD;
  capture.release();
  try {
    await capture.acquire();
    if (wasRecording) capture.start();
  } catch {
    // acquire() already reported through onError; drop to Standby rather
    // than sit in Record with no microphone.
    dispatch({ type: 'mode', to: STANDBY });
  }
  render();
}

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

    const retries: RetryNotice[] = [];

    try {
      // Constructed synchronously, still inside the click, so the context is
      // created while this gesture is unambiguously active.
      audioCtx = new AudioContext();

      // Ask for the microphone BEFORE anything that awaits. This used to sit
      // at the end, behind resume() and a network fetch for the worklet, so
      // the request reached the browser a long way from the click that
      // authorised it. Retried because some interfaces abort their first open
      // — see get-user-media.ts.
      const probeStream = await getUserMediaWithRetry(
        devicePicker.constraints(),
        (notice) => retries.push(notice),
      );
      // What the device actually gave us, before we hand it back. Worth
      // recording even on success: comparing a working machine's settings
      // against a failing one is often what identifies the difference.
      const probeTrack = probeStream.getAudioTracks()[0];
      const probeSettings = probeTrack ? probeTrack.getSettings() : null;
      const probeLabel = probeTrack ? probeTrack.label : null;
      // Released immediately — the browser remembers the grant per-origin, so
      // later acquires (on 'r') never re-prompt and cost near-zero latency.
      probeStream.getTracks().forEach((track) => track.stop());

      await audioCtx.resume();
      await audioCtx.audioWorklet.addModule('./recorder-worklet.js');

      const capacityFrames = Math.floor(MAX_SECONDS * audioCtx.sampleRate);
      ringBuffer = createRingBuffer(capacityFrames);
      takeTracker = createTakeTracker(ringBuffer);

      capture = createCapture({
        audioCtx,
        ringBuffer,
        isMicWanted: micIsWanted,
        getConstraints: () => devicePicker.constraints(),
        isRecording: () => reducerState.mode === RECORD,
        onTakeBegin: () => takeTracker?.beginNewTake(),
        onFramesCaptured: (startAbs, endAbs) => takeTracker?.noteCapturedFrames(startAbs, endAbs),
        onError: showRuntimeError,
      });

      gainControl.attach(audioCtx);

      playback = createPlayback({
        audioCtx,
        ringBuffer,
        getOutputNode: () => gainControl.node,
        getSpeed: () => speedControl.value,
        onEnded: () => { dispatch({ type: 'playbackEnded' }); },
        onMaterialPeak: (peak) => gainControl.setMaterialPeak(peak),
      });

      void reportDiagnostics({
        stage: 'arm succeeded',
        audioCtx,
        runLadder: false,
        note: { probeSettings, probeLabel, retries },
        selectedDeviceId: devicePicker.deviceId,
      });

      armed = true;
      reducerState = initialState();

      if (el.armScreen) el.armScreen.classList.add('hidden');
      if (el.mainUi) el.mainUi.classList.remove('hidden');

      // Device labels only become readable once permission has been
      // granted, so the picker was unlabelled until now.
      void devicePicker.refresh();

      render();
    } catch (err) {
      showArmError(err);
      armButton.disabled = false;
      // Walk the constraint ladder while the failure is fresh, so the report
      // says WHICH request the device refused rather than only that one did.
      void reportDiagnostics({
        stage: 'arm failed',
        audioCtx,
        error: err,
        runLadder: true,
        note: { retries },
        selectedDeviceId: devicePicker.deviceId,
      });
    }
  });
}

// `window.quickReplayDiagnostics()` from the devtools console, any time —
// useful for capturing a report when the app armed fine but the mic misbehaves
// later, e.g. after switching input device mid-session.
installDiagnosticsHook(() => audioCtx);

// Periodic light re-render so the buffer-fill readout / duration
// annotations keep advancing even between worklet messages or effects.
setInterval(() => {
  if (armed) render();
}, 250);
