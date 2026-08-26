// Peak envelope over captured audio: a coarse amplitude summary the ring
// buffer itself doesn't keep. Frames are bucketed into fixed-size windows
// (~21ms at 48kHz with the 1024-frame bucket app.ts uses) and each bucket
// remembers only the loudest sample it has seen — enough to draw a rough
// waveform without holding onto (or re-scanning) the raw samples.

export interface PeakBuffer {
  readonly bucketFrames: number;
  readonly capacityBuckets: number;
  /** Accumulate peaks for `samples`, which begin at absolute frame `startAbs`. */
  write(startAbs: number, samples: Float32Array): void;
  /**
   * Peak amplitudes (0..1) covering the absolute frame range
   * [startAbs, endAbs), resampled into exactly `columns` values, each the
   * maximum over its slice. Ranges with no retained data read as 0.
   */
  readColumns(startAbs: number, endAbs: number, columns: number): Float32Array;
}

export function createPeakBuffer(bucketFrames: number, capacityBuckets: number): PeakBuffer {
  if (!(bucketFrames > 0)) {
    throw new Error('bucketFrames must be a positive number');
  }
  if (!(capacityBuckets > 0)) {
    throw new Error('capacityBuckets must be a positive number');
  }

  const peaks = new Float32Array(capacityBuckets);
  // The highest absolute bucket index written so far. -1 means nothing has
  // been written yet. Tracking this (rather than just writing into slots) is
  // what lets a reused slot be told apart from a genuinely-still-current one:
  // when the ring wraps, the slot for bucket index N is the very same slot
  // that held bucket index N - capacityBuckets, and that old peak must not
  // leak into the new bucket's reading.
  let highestBucket = -1;

  function slotFor(bucketIndex: number): number {
    return ((bucketIndex % capacityBuckets) + capacityBuckets) % capacityBuckets;
  }

  function write(startAbs: number, samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) {
      const absFrame = startAbs + i;
      const bucketIndex = Math.floor(absFrame / bucketFrames);
      const slot = slotFor(bucketIndex);

      // First touch of a bucket beyond anything seen before: the slot may
      // hold a stale peak from a previous lap around the ring (or garbage
      // from initialization), so it must start fresh rather than accumulate
      // on top of that leftover value.
      if (bucketIndex > highestBucket) {
        peaks[slot] = 0;
        highestBucket = bucketIndex;
      }

      const amp = Math.abs(samples[i]);
      if (amp > peaks[slot]) peaks[slot] = amp;
    }
  }

  function readColumns(startAbs: number, endAbs: number, columns: number): Float32Array {
    const out = new Float32Array(Math.max(0, columns));
    if (columns <= 0 || endAbs <= startAbs || highestBucket < 0) return out;

    const oldestBucket = Math.max(0, highestBucket - capacityBuckets + 1);
    const span = endAbs - startAbs;

    for (let c = 0; c < columns; c++) {
      const colStartAbs = startAbs + (span * c) / columns;
      const colEndAbs = startAbs + (span * (c + 1)) / columns;

      const bucketStart = Math.floor(colStartAbs / bucketFrames);
      // At least one bucket (bucketStart itself) is always covered, even
      // when a column is narrower than a single bucket (more columns than
      // buckets in range) and rounding would otherwise give an empty span.
      const bucketEndExclusive = Math.max(bucketStart + 1, Math.ceil(colEndAbs / bucketFrames));

      let peak = 0;
      const lo = Math.max(bucketStart, oldestBucket);
      const hi = Math.min(bucketEndExclusive - 1, highestBucket);
      for (let b = lo; b <= hi; b++) {
        const v = peaks[slotFor(b)];
        if (v > peak) peak = v;
      }
      out[c] = peak;
    }

    return out;
  }

  return {
    bucketFrames,
    capacityBuckets,
    write,
    readColumns,
  };
}
