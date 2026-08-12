// Takes: contiguous stretches of capture, split whenever Record is left for
// Standby or Playback. Boundaries are stored as ABSOLUTE frame positions
// (ringBuffer.totalWritten), never as offsets into the ring buffer. That is
// what makes them survive wraparound: once the buffer is full and old audio
// starts being overwritten, the markers themselves never move — only the
// retained window slides forward past them, and takes fall off the back.

import type { RingBuffer } from './ring-buffer.ts';

export interface Take {
  id: number;
  startAbs: number;
  endAbs: number;
  wallClockStart: number;
}

export interface TakeWindow {
  startAbs: number;
  frames: number;
  trimmed: boolean;
}

export interface TakeTracker {
  readonly takes: readonly Take[];
  readonly currentTake: Take | null;
  /** The next captured frames begin a new take. */
  beginNewTake(): void;
  /** Call after every batch the worklet delivers. */
  noteCapturedFrames(startAbs: number, endAbs: number): void;
  /** Most recent take, clamped to what the buffer still holds. */
  currentTakeWindow(): TakeWindow | null;
}

/** `now` is injectable so tests can assert wallClockStart. Defaults to Date.now. */
export function createTakeTracker(ringBuffer: RingBuffer, now: () => number = Date.now): TakeTracker {
  let takes: Take[] = [];
  let currentTake: Take | null = null;
  let pendingNewTake = false;
  let takeCounter = 0; // stable ids, so labels don't renumber as takes are pruned

  // Drop takes the ring buffer has entirely overwritten, so the list can't
  // grow without bound across a long session.
  function pruneTakes(): void {
    const oldestAbs = ringBuffer.totalWritten - ringBuffer.available;
    if (takes.length && takes[0].endAbs <= oldestAbs) {
      takes = takes.filter((t) => t.endAbs > oldestAbs);
      if (currentTake && !takes.includes(currentTake)) currentTake = null;
    }
  }

  function beginNewTake(): void {
    pendingNewTake = true;
  }

  // Called after every batch the worklet delivers. Deriving take boundaries
  // from the write stream rather than from the stopCapture effect matters:
  // the worklet's flush round-trips through the audio thread, so the final
  // ~85ms of a take arrives *after* the transition. Extending the take on
  // write means that tail lands inside the take it belongs to instead of
  // just outside it.
  function noteCapturedFrames(startAbs: number, endAbs: number): void {
    if (endAbs <= startAbs) return;

    if (pendingNewTake || !currentTake) {
      currentTake = { id: ++takeCounter, startAbs, endAbs, wallClockStart: now() };
      takes.push(currentTake);
      pendingNewTake = false;
    } else {
      currentTake.endAbs = endAbs;
    }

    pruneTakes();
  }

  // The most recent take, clamped to what the buffer still holds. Returns
  // null when there is nothing replayable.
  function currentTakeWindow(): TakeWindow | null {
    if (takes.length === 0) return null;
    const take = takes[takes.length - 1];
    const oldestAbs = ringBuffer.totalWritten - ringBuffer.available;
    const startAbs = Math.max(take.startAbs, oldestAbs);
    const frames = ringBuffer.totalWritten - startAbs;
    if (frames <= 0) return null;
    return { startAbs, frames, trimmed: take.startAbs < oldestAbs };
  }

  return {
    get takes() {
      return takes;
    },
    get currentTake() {
      return currentTake;
    },
    beginNewTake,
    noteCapturedFrames,
    currentTakeWindow,
  };
}
