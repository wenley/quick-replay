// Frame-based ring buffer over a Float32Array. Sample-rate agnostic: the
// caller is responsible for converting seconds to frames before calling in.

/**
 * @param {number} capacityFrames
 * @returns {{
 *   write: (chunk: Float32Array) => void,
 *   readLast: (frames: number) => Float32Array,
 *   readonly available: number,
 *   readonly capacity: number,
 *   clear: () => void,
 * }}
 */
export function createRingBuffer(capacityFrames) {
  if (!(capacityFrames > 0)) {
    throw new Error('capacityFrames must be a positive number');
  }

  const capacity = capacityFrames;
  const buffer = new Float32Array(capacity);
  let writeIndex = 0;
  let totalWritten = 0;

  function write(chunk) {
    let data = chunk;

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
    totalWritten += len;
  }

  function getAvailable() {
    return Math.min(totalWritten, capacity);
  }

  function readLast(frames) {
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

  function clear() {
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
    clear,
  };
}
