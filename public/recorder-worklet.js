// AudioWorkletProcessor that batches raw mic samples into ~85ms chunks and
// posts them to the main thread for the ring buffer to consume.
//
// Loaded via audioWorklet.addModule() — NOT an ES module import target, so
// no import/export statements here. Just the class + registerProcessor.

const BATCH_FRAMES = 4096;

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.batch = new Float32Array(BATCH_FRAMES);
    this.batchIndex = 0;
    this.batchPeak = 0;

    this.port.onmessage = (event) => {
      const data = event.data;
      if (!data) return;
      if (data.type === 'recording') {
        this.recording = !!data.value;
      } else if (data.type === 'flush') {
        this._flush();
      }
    };
  }

  _flush() {
    if (this.batchIndex === 0) return;
    const samples = this.batch.slice(0, this.batchIndex);
    this.port.postMessage({ type: 'audio', samples, peak: this.batchPeak }, [samples.buffer]);
    this.batch = new Float32Array(BATCH_FRAMES);
    this.batchIndex = 0;
    this.batchPeak = 0;
  }

  process(inputs) {
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
        this.port.postMessage({ type: 'audio', samples: this.batch, peak: this.batchPeak }, [this.batch.buffer]);
        this.batch = new Float32Array(BATCH_FRAMES);
        this.batchIndex = 0;
        this.batchPeak = 0;
      }
    }

    return true;
  }
}

registerProcessor('recorder', RecorderProcessor);
