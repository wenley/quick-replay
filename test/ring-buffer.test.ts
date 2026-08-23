import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRingBuffer } from '../src/ring-buffer.ts';

// Sequential integers as floats make ordering bugs obvious at a glance.
function ramp(start: number, count: number): Float32Array {
  const arr = new Float32Array(count);
  for (let i = 0; i < count; i++) arr[i] = start + i;
  return arr;
}

test('write under capacity -> readLast returns exactly what went in, in order', () => {
  const rb = createRingBuffer(10);
  rb.write(ramp(0, 4)); // 0 1 2 3
  const out = rb.readLast(4);
  assert.deepEqual(Array.from(out), [0, 1, 2, 3]);
});

test('readLast more than available returns only what exists, no zero padding', () => {
  const rb = createRingBuffer(10);
  rb.write(ramp(0, 4)); // 0 1 2 3
  const out = rb.readLast(9);
  assert.equal(out.length, 4);
  assert.deepEqual(Array.from(out), [0, 1, 2, 3]);
});

test('wraparound: write 1.5x capacity -> readLast(capacity) returns most recent frames in order', () => {
  const rb = createRingBuffer(10);
  rb.write(ramp(0, 15)); // frames 0..14, capacity 10 -> should hold 5..14
  const out = rb.readLast(10);
  assert.deepEqual(Array.from(out), [5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
});

test('many small chunks straddling the wrap boundary preserve ordering', () => {
  const rb = createRingBuffer(10);
  // 20 chunks of 3 frames each = 60 frames written, values 0..59.
  for (let i = 0; i < 20; i++) {
    rb.write(ramp(i * 3, 3));
  }
  const out = rb.readLast(10);
  assert.deepEqual(Array.from(out), [50, 51, 52, 53, 54, 55, 56, 57, 58, 59]);
});

test('a chunk larger than capacity keeps only its tail', () => {
  const rb = createRingBuffer(5);
  rb.write(ramp(0, 12)); // 0..11, capacity 5 -> only tail 7..11 survives
  assert.equal(rb.available, 5);
  const out = rb.readLast(5);
  assert.deepEqual(Array.from(out), [7, 8, 9, 10, 11]);
});

test('exact-capacity write', () => {
  const rb = createRingBuffer(6);
  rb.write(ramp(0, 6));
  assert.equal(rb.available, 6);
  const out = rb.readLast(6);
  assert.deepEqual(Array.from(out), [0, 1, 2, 3, 4, 5]);
});

test('readLast(0) returns empty', () => {
  const rb = createRingBuffer(10);
  rb.write(ramp(0, 5));
  const out = rb.readLast(0);
  assert.equal(out.length, 0);
});

test('reads against an empty buffer return empty', () => {
  const rb = createRingBuffer(10);
  const out = rb.readLast(5);
  assert.equal(out.length, 0);
});

test('available saturates at capacity and never exceeds it', () => {
  const rb = createRingBuffer(4);
  assert.equal(rb.available, 0);
  rb.write(ramp(0, 3));
  assert.equal(rb.available, 3);
  rb.write(ramp(3, 3));
  assert.equal(rb.available, 4);
  rb.write(ramp(6, 10));
  assert.equal(rb.available, 4);
  assert.equal(rb.capacity, 4);
});

test('totalWritten keeps counting past capacity (absolute coordinate)', () => {
  const rb = createRingBuffer(10);
  assert.equal(rb.totalWritten, 0);
  rb.write(ramp(0, 6));
  assert.equal(rb.totalWritten, 6);
  assert.equal(rb.available, 6);
  // Past capacity: available saturates but totalWritten must not, or take
  // markers recorded against it would collapse onto each other.
  rb.write(ramp(6, 9));
  assert.equal(rb.totalWritten, 15);
  assert.equal(rb.available, 10);
});

test('totalWritten - available gives the oldest retained absolute frame', () => {
  const rb = createRingBuffer(10);
  rb.write(ramp(0, 25));
  assert.equal(rb.totalWritten - rb.available, 15);
  // Frame 15 is the oldest still held; with a 0..24 ramp that is value 15.
  assert.equal(rb.readLast(10)[0], 15);
});

test('clear() resets available to 0', () => {
  const rb = createRingBuffer(8);
  rb.write(ramp(0, 8));
  assert.equal(rb.available, 8);
  rb.clear();
  assert.equal(rb.available, 0);
  assert.equal(rb.readLast(8).length, 0);
});

test('capacityFrames must be positive', () => {
  assert.throws(() => createRingBuffer(0));
  assert.throws(() => createRingBuffer(-3));
});

// --- readRange ---------------------------------------------------------

test('readRange fully inside the retained window returns exactly those values', () => {
  const rb = createRingBuffer(10);
  rb.write(ramp(0, 8)); // 0..7, all retained
  const out = rb.readRange(2, 6);
  assert.deepEqual(Array.from(out), [2, 3, 4, 5]);
});

test('readRange whose start has been overwritten clamps to the oldest retained frame', () => {
  const rb = createRingBuffer(10);
  rb.write(ramp(0, 25)); // 0..24, capacity 10 -> oldest retained is frame 15
  const out = rb.readRange(5, 20);
  assert.equal(out.length, 5);
  assert.deepEqual(Array.from(out), [15, 16, 17, 18, 19]);
});

test('readRange with endAbs beyond totalWritten clamps to totalWritten', () => {
  const rb = createRingBuffer(10);
  rb.write(ramp(0, 8)); // 0..7, totalWritten = 8
  const out = rb.readRange(4, 100);
  assert.deepEqual(Array.from(out), [4, 5, 6, 7]);
});

test('readRange entirely overwritten returns empty', () => {
  const rb = createRingBuffer(10);
  rb.write(ramp(0, 25)); // oldest retained is frame 15
  const out = rb.readRange(0, 10);
  assert.equal(out.length, 0);
});

test('readRange with startAbs >= endAbs returns empty', () => {
  const rb = createRingBuffer(10);
  rb.write(ramp(0, 8));
  assert.equal(rb.readRange(5, 5).length, 0);
  assert.equal(rb.readRange(6, 5).length, 0);
});

test('readRange straddling the physical wrap boundary returns values in order', () => {
  const rb = createRingBuffer(10);
  // Three writes of 5 frames each = 1.5x capacity, landing writeIndex mid-array
  // (at physical index 5) so the retained window [5, 15) is split across the
  // index-9/index-0 seam: frames 5-9 sit at indices 5-9, frames 10-14 at
  // indices 0-4.
  rb.write(ramp(0, 5));
  rb.write(ramp(5, 5));
  rb.write(ramp(10, 5));
  // Ask for a sub-range straddling that seam.
  const out = rb.readRange(8, 12);
  assert.deepEqual(Array.from(out), [8, 9, 10, 11]);
});

test('readRange(totalWritten - n, totalWritten) agrees with readLast(n)', () => {
  const rb = createRingBuffer(10);
  rb.write(ramp(0, 25)); // wrapped several times
  const n = 7;
  const viaRange = rb.readRange(rb.totalWritten - n, rb.totalWritten);
  const viaLast = rb.readLast(n);
  assert.deepEqual(Array.from(viaRange), Array.from(viaLast));
});
