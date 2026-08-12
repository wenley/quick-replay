// Frame-based ring buffer over a Float32Array. Sample-rate agnostic: the
// caller is responsible for converting seconds to frames before calling in.

export interface RingBuffer {
  write(chunk: Float32Array): void;
  /**
   * The `frames` most recently written frames, oldest first. Returns a
   * SHORTER array than asked for when the buffer holds less — that is a
   * normal result, not an error, and callers are expected to surface it.
   */
  readLast(frames: number): Float32Array;
  /** Frames currently retained, i.e. `min(totalWritten, capacity)`. */
  readonly available: number;
  readonly capacity: number;
  /**
   * Total frames ever written, including those since overwritten. Callers use
   * this as a stable absolute coordinate: a position recorded against it stays
   * valid as the buffer wraps, because only the retained window moves, never
   * the coordinate itself.
   */
  readonly totalWritten: number;
  clear(): void;
}

export function createRingBuffer(capacityFrames: number): RingBuffer {
  if (!(capacityFrames > 0)) {
    throw new Error('capacityFrames must be a positive number');
  }

  const capacity = capacityFrames;
  const buffer = new Float32Array(capacity);
  let writeIndex = 0;
  let totalWritten = 0;

  function write(chunk: Float32Array): void {
    let data = chunk;

    // Count every frame handed to us, including any dropped just below.
    // totalWritten is an absolute position in the audio stream, so it has to
    // advance by what was written, not by what happened to be retained -
    // otherwise positions recorded against it drift out of sync.
    const writtenFrames = chunk.length;

    // If the incoming chunk alone is bigger than the whole buffer, only its
    // tail can possibly survive - drop the head up front.
    if (data.length > capacity) {
      data = data.subarray(data.length - capacity);
    }

    const len = data.length;
    const spaceToEnd = capacity - writeIndex;

    if (len <= spaceToEnd) {
      buffer.set(data, writeIndex);
    } else {
      // Wraps around the end of the backing array: first part fills to the
      // end, second part continues from index 0. At most two .set() calls.
      buffer.set(data.subarray(0, spaceToEnd), writeIndex);
      buffer.set(data.subarray(spaceToEnd), 0);
    }

    writeIndex = (writeIndex + len) % capacity;
    totalWritten += writtenFrames;
  }

  function getAvailable(): number {
    return Math.min(totalWritten, capacity);
  }

  function readLast(frames: number): Float32Array {
    const avail = getAvailable();
    const n = Math.min(frames, avail);
    const out = new Float32Array(n);
    if (n === 0) return out;

    // The n most recently written frames start here, wrapping if needed.
    const start = (writeIndex - n + capacity) % capacity;
    const spaceToEnd = capacity - start;

    if (n <= spaceToEnd) {
      out.set(buffer.subarray(start, start + n));
    } else {
      out.set(buffer.subarray(start, capacity), 0);
      out.set(buffer.subarray(0, n - spaceToEnd), spaceToEnd);
    }

    return out;
  }

  function clear(): void {
    writeIndex = 0;
    totalWritten = 0;
  }

  return {
    write,
    readLast,
    get available() {
      return getAvailable();
    },
    get capacity() {
      return capacity;
    },
    get totalWritten() {
      return totalWritten;
    },
    clear,
  };
}
