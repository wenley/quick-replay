import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRingBuffer, type RingBuffer } from '../src/ring-buffer.ts';
import { createTakeTracker, type TakeTracker } from '../src/takes.ts';

// Mirrors exactly what app.ts's worklet onmessage handler does: snapshot
// totalWritten before the write, then hand the tracker the before/after pair.
function capture(rb: RingBuffer, tracker: TakeTracker, frames: number): void {
  const startAbs = rb.totalWritten;
  rb.write(new Float32Array(frames));
  tracker.noteCapturedFrames(startAbs, rb.totalWritten);
}

test('first capture creates take 1 with matching startAbs/endAbs', () => {
  const rb = createRingBuffer(100);
  const tracker = createTakeTracker(rb);
  capture(rb, tracker, 10);
  assert.equal(tracker.takes.length, 1);
  assert.equal(tracker.takes[0].id, 1);
  assert.equal(tracker.takes[0].startAbs, 0);
  assert.equal(tracker.takes[0].endAbs, 10);
});

test('consecutive captures extend the current take rather than creating new ones', () => {
  const rb = createRingBuffer(100);
  const tracker = createTakeTracker(rb);
  capture(rb, tracker, 10);
  capture(rb, tracker, 5);
  capture(rb, tracker, 5);
  assert.equal(tracker.takes.length, 1);
  assert.equal(tracker.takes[0].startAbs, 0);
  assert.equal(tracker.takes[0].endAbs, 20);
});

test('beginNewTake() then a capture creates a second take with a distinct, higher id', () => {
  const rb = createRingBuffer(100);
  const tracker = createTakeTracker(rb);
  capture(rb, tracker, 10);
  tracker.beginNewTake();
  capture(rb, tracker, 10);
  assert.equal(tracker.takes.length, 2);
  assert.equal(tracker.takes[0].id, 1);
  assert.equal(tracker.takes[1].id, 2);
  assert.ok(tracker.takes[1].id > tracker.takes[0].id);
  assert.equal(tracker.takes[1].startAbs, 10);
  assert.equal(tracker.takes[1].endAbs, 20);
});

test('beginNewTake() alone, with no capture after it, creates nothing', () => {
  const rb = createRingBuffer(100);
  const tracker = createTakeTracker(rb);
  capture(rb, tracker, 10);
  tracker.beginNewTake();
  assert.equal(tracker.takes.length, 1);
  assert.equal(tracker.takes[0].endAbs, 10);
});

test('noteCapturedFrames with endAbs <= startAbs is a no-op', () => {
  const rb = createRingBuffer(100);
  const tracker = createTakeTracker(rb);
  tracker.noteCapturedFrames(5, 5);
  assert.equal(tracker.takes.length, 0);
  assert.equal(tracker.currentTake, null);

  tracker.noteCapturedFrames(5, 3);
  assert.equal(tracker.takes.length, 0);
  assert.equal(tracker.currentTake, null);
});

test('take ids are stable across pruning: surviving takes keep their original ids', () => {
  const rb = createRingBuffer(30);
  const tracker = createTakeTracker(rb);

  // Three separate takes of 10 frames each; the buffer only holds 30, so
  // once a fourth take is captured the first should be pruned entirely.
  capture(rb, tracker, 10); // take 1: [0, 10)
  tracker.beginNewTake();
  capture(rb, tracker, 10); // take 2: [10, 20)
  tracker.beginNewTake();
  capture(rb, tracker, 10); // take 3: [20, 30)
  assert.deepEqual(tracker.takes.map((t) => t.id), [1, 2, 3]);

  tracker.beginNewTake();
  capture(rb, tracker, 10); // take 4: [30, 40) — oldest retained is now 10, take 1 fully overwritten

  const ids = tracker.takes.map((t) => t.id);
  assert.deepEqual(ids, [2, 3, 4]);
});

test('a take whose frames have been entirely overwritten is dropped from takes', () => {
  const rb = createRingBuffer(20);
  const tracker = createTakeTracker(rb);
  capture(rb, tracker, 10); // take 1: [0, 10)
  tracker.beginNewTake();
  capture(rb, tracker, 10); // take 2: [10, 20)
  assert.equal(tracker.takes.length, 2);

  tracker.beginNewTake();
  capture(rb, tracker, 10); // take 3: [20, 30) -> oldest retained abs = 30 - 20 = 10, take 1 fully gone
  assert.equal(tracker.takes.some((t) => t.id === 1), false);
  assert.equal(tracker.takes.length, 2);
});

test('currentTake becomes null when the take it points at is pruned', () => {
  // Under normal paired use (report every write immediately) currentTake's
  // endAbs always tracks ringBuffer.totalWritten, so it can never itself
  // fall behind the oldest-retained cutoff. Exercise the defensive prune
  // guard directly: write to the ring buffer WITHOUT reporting it to the
  // tracker, so the tracker's notion of "current" goes stale relative to
  // what the buffer actually retains, then extend the (still-referenced)
  // current take by a small amount so pruneTakes runs against real buffer
  // state that has raced ahead of it.
  const rb = createRingBuffer(10);
  const tracker = createTakeTracker(rb);
  capture(rb, tracker, 5); // take 1: [0, 5)
  assert.notEqual(tracker.currentTake, null);

  rb.write(new Float32Array(20)); // buffer races ahead unreported: totalWritten=25, oldestAbs=15
  tracker.noteCapturedFrames(5, 6); // extend current take by a token amount; triggers pruneTakes

  assert.equal(tracker.takes.length, 0);
  assert.equal(tracker.currentTake, null);
});

test('a partially overwritten take stays in the list, keeping its original startAbs', () => {
  const rb = createRingBuffer(20);
  const tracker = createTakeTracker(rb);
  capture(rb, tracker, 10); // take 1: [0, 10)
  tracker.beginNewTake();
  capture(rb, tracker, 15); // take 2: [10, 25) -> total written 25, oldest retained = 25-20=5

  // Take 1 (endAbs=10) is not <= oldestAbs(5), so it survives, still with its
  // original startAbs even though frames [0,5) are gone from the buffer.
  assert.equal(tracker.takes.length, 2);
  assert.equal(tracker.takes[0].id, 1);
  assert.equal(tracker.takes[0].startAbs, 0);
  assert.equal(tracker.takes[0].endAbs, 10);
});

test('currentTakeWindow returns trimmed:false and the true start when fully retained', () => {
  const rb = createRingBuffer(100);
  const tracker = createTakeTracker(rb);
  capture(rb, tracker, 10);
  const window = tracker.currentTakeWindow();
  assert.ok(window);
  assert.equal(window.trimmed, false);
  assert.equal(window.startAbs, 0);
  assert.equal(window.frames, 10);
});

test('currentTakeWindow clamps startAbs and reports trimmed once the take exceeds buffer capacity', () => {
  const rb = createRingBuffer(10);
  const tracker = createTakeTracker(rb);
  capture(rb, tracker, 10); // take 1: [0,10), fills buffer exactly
  capture(rb, tracker, 5); // extends take to [0, 15); oldest retained = 15-10=5

  const window = tracker.currentTakeWindow();
  assert.ok(window);
  assert.equal(window.trimmed, true);
  assert.equal(window.startAbs, 5);
  assert.equal(window.frames, 10);
});

test('currentTakeWindow returns null when nothing has been captured', () => {
  const rb = createRingBuffer(100);
  const tracker = createTakeTracker(rb);
  assert.equal(tracker.currentTakeWindow(), null);
});

test('wallClockStart comes from the injected now function', () => {
  const rb = createRingBuffer(100);
  let fakeNow = 12345;
  const tracker = createTakeTracker(rb, () => fakeNow);
  capture(rb, tracker, 10);
  assert.equal(tracker.takes[0].wallClockStart, 12345);

  fakeNow = 99999;
  tracker.beginNewTake();
  capture(rb, tracker, 10);
  assert.equal(tracker.takes[1].wallClockStart, 99999);
});

test('a long session with many takes does not grow the list without bound', () => {
  const rb = createRingBuffer(1000);
  const tracker = createTakeTracker(rb);
  for (let i = 0; i < 500; i++) {
    tracker.beginNewTake();
    capture(rb, tracker, 50); // each take is 50 frames, buffer holds 1000 -> ~20 takes max
  }
  assert.ok(tracker.takes.length < 30, `expected a small bounded list, got ${tracker.takes.length}`);
});
