// AudioWorkletProcessor that batches raw mic samples into ~85ms chunks and
// posts them to the main thread for the ring buffer to consume.
//
// Loaded via audioWorklet.addModule(), into a scope with no module resolution
// — so this file must emit no runtime imports or exports at all. The message
// types come in via `import type`, which erases to nothing; keep it that way.

// Inline import() types rather than an `import type` statement: an import
// statement of any kind would make this a module and have tsc emit `export {}`
// to say so. These erase without a trace and leave the file a plain script.
type RecorderCommand = import('./audio-messages.ts').RecorderCommand;
type RecorderAudioMessage = import('./audio-messages.ts').RecorderAudioMessage;

const BATCH_FRAMES = 4096;

class RecorderProcessor extends AudioWorkletProcessor {
  private recording = false;
  private batch = new Float32Array(BATCH_FRAMES);
  private batchIndex = 0;
  private batchPeak = 0;

  constructor() {
    super();

    this.port.onmessage = (event: MessageEvent<RecorderCommand>) => {
      const data = event.data;
      if (!data) return;
      if (data.type === 'recording') {
        this.recording = !!data.value;
      } else if (data.type === 'flush') {
        this.postBatch(this.batch.slice(0, this.batchIndex));
      }
    };
  }

  /**
   * Hands `samples` to the main thread and starts a fresh batch. The buffer is
   * transferred rather than copied, which is why a new Float32Array has to be
   * allocated every time — the old one is detached the moment it is posted.
   */
  private postBatch(samples: Float32Array): void {
    if (samples.length === 0) return;
    const message: RecorderAudioMessage = { type: 'audio', samples, peak: this.batchPeak };
    this.port.postMessage(message, [samples.buffer]);
    this.batch = new Float32Array(BATCH_FRAMES);
    this.batchIndex = 0;
    this.batchPeak = 0;
  }

  process(inputs: Float32Array[][]): boolean {
    if (!this.recording) return true;

    const input = inputs[0];
    if (!input || !input[0]) return true;

    const channel = input[0];

    for (let i = 0; i < channel.length; i++) {
      const sample = channel[i];
      this.batch[this.batchIndex] = sample;
      this.batchIndex++;

      const abs = sample < 0 ? -sample : sample;
      if (abs > this.batchPeak) this.batchPeak = abs;

      if (this.batchIndex >= BATCH_FRAMES) {
        // Full batch: hand over the batch array itself, no copy.
        this.postBatch(this.batch);
      }
    }

    return true;
  }
}

registerProcessor('recorder', RecorderProcessor);
