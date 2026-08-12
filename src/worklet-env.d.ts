// The AudioWorklet global scope.
//
// An AudioWorkletProcessor runs on the audio rendering thread, whose globals
// are described by neither lib.dom (the window scope) nor lib.webworker (the
// worker scope), so TypeScript ships no definitions for them at all. These are
// the two the recorder actually touches.
//
// Declared globally rather than exported, because that is genuinely what they
// are inside a worklet module — there is nothing to import them from.

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}

/**
 * `inputs[input][channel]` is a Float32Array of exactly 128 frames — the
 * render quantum. Returning true keeps the processor alive; returning false
 * lets the browser garbage-collect it.
 */
type AudioWorkletProcessorConstructor = new () => AudioWorkletProcessor & {
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
};

declare function registerProcessor(
  name: string,
  processorCtor: AudioWorkletProcessorConstructor,
): void;
