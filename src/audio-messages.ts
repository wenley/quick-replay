// The contract across the audio-thread boundary, shared by the worklet that
// posts these and the main thread that receives them.
//
// Type-only on purpose. Both sides import it with `import type`, which erases
// completely — the worklet in particular must not gain a real runtime import,
// because it is loaded by addModule() into a scope with no module resolution
// for anything it might reach for.

/** Main thread -> worklet. */
export type RecorderCommand =
  | { type: 'recording'; value: boolean }
  | { type: 'flush' };

/** Worklet -> main thread. One batch of captured mono frames. */
export interface RecorderAudioMessage {
  type: 'audio';
  samples: Float32Array;
  /** Largest absolute sample in this batch, for the level meter. */
  peak: number;
}
