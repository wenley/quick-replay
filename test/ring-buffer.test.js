import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRingBuffer } from '../public/ring-buffer.js';

// Sequential integers as floats make ordering bugs obvious at a glance.
function ramp(start, count) {
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
