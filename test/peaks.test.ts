import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPeakBuffer } from '../src/peaks.ts';

function constant(value: number, count: number): Float32Array {
  const arr = new Float32Array(count);
  arr.fill(value);
  return arr;
}

test('constant amplitude in -> every column reads that amplitude', () => {
  const pb = createPeakBuffer(10, 20); // 20 buckets * 10 frames = 200 frames
  pb.write(0, constant(0.4, 200));
  const cols = pb.readColumns(0, 200, 8);
  assert.equal(cols.length, 8);
  for (const v of cols) assert.ok(Math.abs(v - 0.4) < 1e-6, `expected ~0.4, got ${v}`);
});

test('a loud burst in a known frame range appears only in the corresponding column', () => {
  const bucketFrames = 10;
  const pb = createPeakBuffer(bucketFrames, 10); // 100 frames total
  const samples = constant(0.1, 100);
  // Burst in frames [40, 50) -> bucket 4.
  for (let i = 40; i < 50; i++) samples[i] = 0.9;
  pb.write(0, samples);

  const cols = pb.readColumns(0, 100, 10); // one column per bucket
  for (let c = 0; c < 10; c++) {
    if (c === 4) {
      assert.ok(Math.abs(cols[c] - 0.9) < 1e-6, `bucket 4 should read the burst, got ${cols[c]}`);
    } else {
      assert.ok(Math.abs(cols[c] - 0.1) < 1e-6, `bucket ${c} should read background, got ${cols[c]}`);
    }
  }
});

test('silence reads 0', () => {
  const pb = createPeakBuffer(10, 10);
  pb.write(0, constant(0, 100));
  const cols = pb.readColumns(0, 100, 10);
  for (const v of cols) assert.equal(v, 0);
});

test('accumulation across calls: the straddling case keeps the max, not just the last write', () => {
  const bucketFrames = 10;
  const pb = createPeakBuffer(bucketFrames, 10);
  // Bucket 0 covers frames [0, 10). Split its write across two calls, with
  // the SECOND call holding the louder sample.
  pb.write(0, constant(0.2, 5)); // frames 0..4, quiet
  pb.write(5, constant(0.7, 5)); // frames 5..9, loud
  const cols = pb.readColumns(0, 10, 1);
  assert.ok(Math.abs(cols[0] - 0.7) < 1e-6, `expected bucket to keep the max 0.7, got ${cols[0]}`);
});

test('negative samples register via absolute value', () => {
  const pb = createPeakBuffer(10, 10);
  const samples = constant(0, 10);
  samples[3] = -0.8;
  pb.write(0, samples);
  const cols = pb.readColumns(0, 10, 1);
  assert.ok(Math.abs(cols[0] - 0.8) < 1e-6, `expected 0.8, got ${cols[0]}`);
});

test('stale-slot rejection: a reused slot reflects only the new (quieter) audio', () => {
  const bucketFrames = 10;
  const capacityBuckets = 4; // ring holds 4 buckets = 40 frames
  const pb = createPeakBuffer(bucketFrames, capacityBuckets);

  // Bucket 0 gets a LOUD peak first.
  pb.write(0, constant(0.95, bucketFrames));
  // Advance past the whole ring so bucket index 0's slot (slot 0 % 4 = 0)
  // gets reused by bucket index 4, which is quieter. If the reused slot
  // inherited the old 0.95 peak, this would be an obvious, wrong spike.
  for (let bucketIndex = 1; bucketIndex < 4; bucketIndex++) {
    pb.write(bucketIndex * bucketFrames, constant(0.1, bucketFrames));
  }
  // Bucket index 4 reuses slot 0 (4 % 4 === 0).
  pb.write(4 * bucketFrames, constant(0.2, bucketFrames));

  const cols = pb.readColumns(4 * bucketFrames, 5 * bucketFrames, 1);
  assert.ok(Math.abs(cols[0] - 0.2) < 1e-6, `stale peak leaked into reused slot, got ${cols[0]}`);
  assert.ok(cols[0] < 0.95, 'reused slot must not inherit the old louder peak');
});

test('reading a range entirely older than what is retained returns all zeros', () => {
  const bucketFrames = 10;
  const capacityBuckets = 4;
  const pb = createPeakBuffer(bucketFrames, capacityBuckets);

  // Write bucket 0 loud, then advance far enough that it is fully evicted.
  pb.write(0, constant(0.9, bucketFrames));
  for (let bucketIndex = 1; bucketIndex <= 10; bucketIndex++) {
    pb.write(bucketIndex * bucketFrames, constant(0.05, bucketFrames));
  }

  const cols = pb.readColumns(0, bucketFrames, 4);
  for (const v of cols) assert.equal(v, 0);
});

test('readColumns returns exactly `columns` values for various column counts', () => {
  const pb = createPeakBuffer(10, 20);
  pb.write(0, constant(0.5, 200));

  for (const columns of [1, 3, 8, 50, 200, 500]) {
    const cols = pb.readColumns(0, 200, columns);
    assert.equal(cols.length, columns, `expected ${columns} columns, got ${cols.length}`);
  }
});

test('more columns than buckets in range still reads a sensible value per column', () => {
  const bucketFrames = 10;
  const pb = createPeakBuffer(bucketFrames, 5); // 50 frames total, 5 buckets
  const samples = constant(0.1, 50);
  for (let i = 20; i < 30; i++) samples[i] = 0.8; // bucket 2 is loud
  pb.write(0, samples);

  // 50 columns over 50 frames -> one column per frame, far more than 5 buckets.
  const cols = pb.readColumns(0, 50, 50);
  assert.equal(cols.length, 50);
  // Columns falling in frames [20, 30) should read the loud bucket's peak.
  for (let i = 20; i < 30; i++) {
    assert.ok(Math.abs(cols[i] - 0.8) < 1e-6, `column ${i} expected ~0.8, got ${cols[i]}`);
  }
  // Columns outside it should read the quiet background.
  assert.ok(Math.abs(cols[0] - 0.1) < 1e-6);
  assert.ok(Math.abs(cols[49] - 0.1) < 1e-6);
});

test('values are always within 0..1 for in-range input', () => {
  const pb = createPeakBuffer(10, 10);
  const samples = new Float32Array(100);
  for (let i = 0; i < 100; i++) samples[i] = Math.sin(i) * 0.999;
  pb.write(0, samples);

  const cols = pb.readColumns(0, 100, 37);
  for (const v of cols) {
    assert.ok(v >= 0 && v <= 1, `value out of range: ${v}`);
  }
});

test('writes straddling a bucket boundary within one call still bucket correctly', () => {
  const bucketFrames = 10;
  const pb = createPeakBuffer(bucketFrames, 10);
  // One write spans buckets 0, 1, and 2 with a loud sample only in bucket 1.
  const samples = constant(0.1, 30);
  samples[15] = 0.6; // frame 15 -> bucket 1
  pb.write(0, samples);

  const cols = pb.readColumns(0, 30, 3);
  assert.ok(Math.abs(cols[0] - 0.1) < 1e-6);
  assert.ok(Math.abs(cols[1] - 0.6) < 1e-6);
  assert.ok(Math.abs(cols[2] - 0.1) < 1e-6);
});
