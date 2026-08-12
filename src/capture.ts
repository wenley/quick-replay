// Microphone capture: acquiring/releasing the mic, driving the recorder
// worklet, and the input level meter that reads off it. The level meter
// lives here (not in a separate component) because it is fed by the worklet
// and is only meaningful while recording — it is capture's own readout.

import type { RingBuffer } from './ring-buffer.ts';
import type { RecorderCommand, RecorderAudioMessage } from './audio-messages.ts';
import { MIC_CONSTRAINTS } from './config.ts';
import { el, messageOf } from './dom.ts';

export interface Capture {
  /** Acquire the mic and build source -> worklet -> gain(0) -> destination. */
  acquire(): Promise<void>;
  release(): void;
  /** Begin capturing into the ring buffer. */
  start(): void;
  stop(): void;
  flush(): void;
  readonly micHeld: boolean;
}

export interface CaptureDeps {
  audioCtx: AudioContext;
  ringBuffer: RingBuffer;
  /** Whether the app still wants a mic by the time getUserMedia resolves. */
  isMicWanted: () => boolean;
  /** Whether the app is in Record. Gates start(), and drives the level meter loop. */
  isRecording: () => boolean;
  /** Every entry into Record begins a new take. */
  onTakeBegin: () => void;
  /** Called after each batch is written to the ring buffer. */
  onFramesCaptured: (startAbs: number, endAbs: number) => void;
  onError: (message: string) => void;
}

export function createCapture(deps: CaptureDeps): Capture {
  const { audioCtx: ctx, ringBuffer: buffer } = deps;

  let mediaStream: MediaStream | null = null;
  let sourceNode: MediaStreamAudioSourceNode | null = null;
  let workletNode: AudioWorkletNode | null = null;
  let gainNode: GainNode | null = null;
  let micHeld = false;

  // --- level meter ---------------------------------------------------------

  const LEVEL_DECAY = 0.85; // per animation frame, ~60fps
  let latestPeak = 0;
  let displayedLevel = 0;
  let levelRaf: number | null = null;

  function updateLevelMeterFromWorklet(peak: number): void {
    if (peak > latestPeak) latestPeak = peak;
  }

  function levelMeterTick(): void {
    displayedLevel = Math.max(latestPeak, displayedLevel * LEVEL_DECAY);
    latestPeak = 0;
    renderLevelMeter(displayedLevel);

    if (deps.isRecording()) {
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

  // --- mic lifecycle ---------------------------------------------------------

  async function acquire(): Promise<void> {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS);
    } catch (err) {
      const detail = messageOf(err);
      deps.onError(`Microphone access failed: ${detail || err}`);
      throw err;
    }

    // Guard on *intent*, not on a bare event counter. Something may have
    // superseded us during the ~100-300ms getUserMedia takes — but pressing
    // `r` twice also bumps that counter, and must not strand us in Record
    // with no mic. `micHeld` catches a concurrent acquire winning the race.
    if (!deps.isMicWanted() || micHeld) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    mediaStream = stream;
    sourceNode = ctx.createMediaStreamSource(stream);
    workletNode = new AudioWorkletNode(ctx, 'recorder');
    workletNode.port.onmessage = (event: MessageEvent<RecorderAudioMessage>) => {
      const data = event.data;
      if (!data || data.type !== 'audio') return;
      const startAbs = buffer.totalWritten;
      buffer.write(data.samples);
      deps.onFramesCaptured(startAbs, buffer.totalWritten);
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

  function release(): void {
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

  function start(): void {
    // A dispatch that awaited getUserMedia can land here after a later event
    // has moved us out of Record; never enable capture outside Record, or we'd
    // record during playback and feed the speakers back into the mic.
    if (!deps.isRecording()) return;
    // Every entry into Record begins a new take, including the return from a
    // playback — that discontinuity is exactly what the markers exist to show.
    deps.onTakeBegin();
    if (workletNode) {
      const command: RecorderCommand = { type: 'recording', value: true };
      workletNode.port.postMessage(command);
    }
    startLevelMeterLoop();
  }

  function stop(): void {
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

  return {
    acquire,
    release,
    start,
    stop,
    flush,
    get micHeld(): boolean {
      return micHeld;
    },
  };
}
