import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initialState,
  reduce,
  STANDBY,
  RECORD,
  PLAYBACK,
  ACQUIRE_MIC,
  RELEASE_MIC,
  START_CAPTURE,
  STOP_CAPTURE,
  FLUSH,
  START_PLAYBACK,
  STOP_PLAYBACK,
} from '../src/transitions.ts';
import type { Effect, State } from '../src/transitions.ts';

function types(effects: Effect[]): string[] {
  return effects.map((e) => e.type);
}

const held = { micHeld: true };
const noMic = { micHeld: false };

test('previousMode is set on entry to playback and survives a duration re-trigger mid-playback', () => {
  const state: State = { mode: RECORD, previousMode: STANDBY, playbackSource: null };

  let result = reduce(state, { type: 'duration', seconds: 2, source: '1' }, held);
  assert.equal(result.state.mode, PLAYBACK);
  assert.equal(result.state.previousMode, RECORD);

  // Re-trigger while already in playback must NOT touch previousMode. A
  // DIFFERENT source, so this is a re-trigger rather than the exit gesture.
  result = reduce(result.state, { type: 'duration', seconds: 5, source: '2' }, held);
  assert.equal(result.state.mode, PLAYBACK);
  assert.equal(result.state.previousMode, RECORD);
});

test('playbackEnded from record->playback returns to record; from standby->playback returns to standby', () => {
  const fromRecord = reduce(
    { mode: RECORD, previousMode: STANDBY, playbackSource: null },
    { type: 'duration', seconds: 2, source: '1' },
    held,
  );
  const ended = reduce(fromRecord.state, { type: 'playbackEnded' }, held);
  assert.equal(ended.state.mode, RECORD);

  const fromStandby = reduce(
    { mode: STANDBY, previousMode: STANDBY, playbackSource: null },
    { type: 'duration', seconds: 2, source: '1' },
    held,
  );
  const ended2 = reduce(fromStandby.state, { type: 'playbackEnded' }, held);
  assert.equal(ended2.state.mode, STANDBY);
});

test('escape during playback lands in standby even when previousMode is record', () => {
  const state: State = { mode: PLAYBACK, previousMode: RECORD, playbackSource: '1' };
  const result = reduce(state, { type: 'escape' }, held);
  assert.equal(result.state.mode, STANDBY);
  assert.deepEqual(types(result.effects), [STOP_PLAYBACK, STOP_CAPTURE, FLUSH, RELEASE_MIC]);
});

test('back during playback returns to previousMode', () => {
  const state: State = { mode: PLAYBACK, previousMode: RECORD, playbackSource: '1' };
  const result = reduce(state, { type: 'back' }, held);
  assert.equal(result.state.mode, RECORD);
  assert.deepEqual(types(result.effects), [STOP_PLAYBACK, START_CAPTURE]);

  const state2: State = { mode: PLAYBACK, previousMode: STANDBY, playbackSource: '1' };
  const result2 = reduce(state2, { type: 'back' }, held);
  assert.equal(result2.state.mode, STANDBY);
  assert.deepEqual(types(result2.effects), [STOP_PLAYBACK, STOP_CAPTURE, FLUSH, RELEASE_MIC]);
});

test('entering record emits acquireMic only when context.micHeld is false', () => {
  const withoutMic = reduce(
    { mode: STANDBY, previousMode: STANDBY, playbackSource: null },
    { type: 'mode', to: RECORD },
    noMic,
  );
  assert.deepEqual(types(withoutMic.effects), [ACQUIRE_MIC, START_CAPTURE]);

  const withMic = reduce(
    { mode: STANDBY, previousMode: STANDBY, playbackSource: null },
    { type: 'mode', to: RECORD },
    held,
  );
  assert.deepEqual(types(withMic.effects), [START_CAPTURE]);
});

test('entering standby always emits releaseMic; entering playback never emits releaseMic', () => {
  const toStandby = reduce(
    { mode: RECORD, previousMode: STANDBY, playbackSource: null },
    { type: 'mode', to: STANDBY },
    held,
  );
  assert.ok(types(toStandby.effects).includes(RELEASE_MIC));

  const toPlayback = reduce(
    { mode: RECORD, previousMode: STANDBY, playbackSource: null },
    { type: 'duration', seconds: 3, source: '1' },
    held,
  );
  assert.ok(!types(toPlayback.effects).includes(RELEASE_MIC));
});

test('re-trigger emits stopPlayback before startPlayback and carries the new seconds', () => {
  const inPlayback: State = { mode: PLAYBACK, previousMode: RECORD, playbackSource: '1' };
  const result = reduce(inPlayback, { type: 'duration', seconds: 7, source: '3' }, held);
  assert.deepEqual(types(result.effects), [STOP_PLAYBACK, START_PLAYBACK]);
  const startEffect = result.effects.find((e) => e.type === START_PLAYBACK);
  assert.ok(startEffect);
  assert.equal(startEffect.seconds, 7);
});

test('playbackEnded outside playback is a no-op', () => {
  const state: State = { mode: RECORD, previousMode: STANDBY, playbackSource: null };
  const result = reduce(state, { type: 'playbackEnded' }, held);
  assert.equal(result.state.mode, RECORD);
  assert.deepEqual(result.effects, []);
});

test('reduce does not mutate the input state object', () => {
  const state: State = Object.freeze({ mode: RECORD, previousMode: STANDBY, playbackSource: null });
  assert.doesNotThrow(() => reduce(state, { type: 'duration', seconds: 3, source: '1' }, held));
  assert.equal(state.mode, RECORD);
  assert.equal(state.previousMode, STANDBY);
});

test('initialState returns standby/standby with no playback source', () => {
  assert.deepEqual(initialState(), { mode: STANDBY, previousMode: STANDBY, playbackSource: null });
});

test('a mode event naming the current mode is a no-op', () => {
  const state: State = { mode: RECORD, previousMode: STANDBY, playbackSource: null };
  const result = reduce(state, { type: 'mode', to: RECORD }, held);
  assert.equal(result.state.mode, RECORD);
  assert.deepEqual(result.effects, []);
});

test('back in record toggles to standby, releasing the mic', () => {
  const state: State = { mode: RECORD, previousMode: STANDBY, playbackSource: null };
  const result = reduce(state, { type: 'back' }, held);
  assert.equal(result.state.mode, STANDBY);
  assert.deepEqual(types(result.effects), [STOP_CAPTURE, FLUSH, RELEASE_MIC]);
});

test('back in standby toggles to record, acquiring the mic', () => {
  const state: State = { mode: STANDBY, previousMode: STANDBY, playbackSource: null };
  const result = reduce(state, { type: 'back' }, noMic);
  assert.equal(result.state.mode, RECORD);
  assert.deepEqual(types(result.effects), [ACQUIRE_MIC, START_CAPTURE]);
});

test('back still returns to previous mode while in playback (not a toggle)', () => {
  const state: State = { mode: PLAYBACK, previousMode: RECORD, playbackSource: '1' };
  const result = reduce(state, { type: 'back' }, held);
  assert.equal(result.state.mode, RECORD);
  assert.deepEqual(types(result.effects), [STOP_PLAYBACK, START_CAPTURE]);
});

// --- re-pressing the active trigger exits playback --------------------------

test('the same source while in playback exits to previousMode, exactly like back', () => {
  const state: State = { mode: PLAYBACK, previousMode: RECORD, playbackSource: '2' };
  const exit = reduce(state, { type: 'duration', seconds: 10, source: '2' }, held);

  assert.equal(exit.state.mode, RECORD);
  assert.equal(exit.state.playbackSource, null);
  assert.deepEqual(types(exit.effects), [STOP_PLAYBACK, START_CAPTURE]);

  // Byte-for-byte the same as what `back` produces from the same state.
  const viaBack = reduce(state, { type: 'back' }, held);
  assert.deepEqual(exit.effects, viaBack.effects);
  assert.deepEqual(exit.state, viaBack.state);
});

test('the same source exits to standby when the playback was launched from standby', () => {
  const state: State = { mode: PLAYBACK, previousMode: STANDBY, playbackSource: '4' };
  const exit = reduce(state, { type: 'duration', seconds: 60, source: '4' }, held);

  assert.equal(exit.state.mode, STANDBY);
  assert.equal(exit.state.playbackSource, null);
  assert.deepEqual(types(exit.effects), [STOP_PLAYBACK, STOP_CAPTURE, FLUSH, RELEASE_MIC]);
});

test('a different source re-triggers instead of exiting, and adopts the new source', () => {
  const state: State = { mode: PLAYBACK, previousMode: RECORD, playbackSource: '2' };
  const result = reduce(state, { type: 'duration', seconds: 30, source: '3' }, held);

  assert.equal(result.state.mode, PLAYBACK);
  assert.equal(result.state.playbackSource, '3');
  // previousMode still points at the mode the ORIGINAL entry came from.
  assert.equal(result.state.previousMode, RECORD);
  assert.deepEqual(types(result.effects), [STOP_PLAYBACK, START_PLAYBACK]);
});

test('q exits playback when pressed a second time, like the digit keys', () => {
  const state: State = { mode: PLAYBACK, previousMode: RECORD, playbackSource: 'q' };
  const exit = reduce(state, { type: 'duration', seconds: 12, source: 'q' }, held);
  assert.equal(exit.state.mode, RECORD);
  assert.deepEqual(types(exit.effects), [STOP_PLAYBACK, START_CAPTURE]);
});

test('a null source ALWAYS re-triggers and never exits', () => {
  // This is the speed-change path: crossing the 1.0x boundary swaps
  // time-stretch engines and has to restart the clip. If it ever matched the
  // exit branch, changing speed mid-clip would drop you out of playback.
  const withSource: State = { mode: PLAYBACK, previousMode: RECORD, playbackSource: '2' };
  const a = reduce(withSource, { type: 'duration', seconds: 10, source: null }, held);
  assert.equal(a.state.mode, PLAYBACK);
  assert.deepEqual(types(a.effects), [STOP_PLAYBACK, START_PLAYBACK]);

  // The null === null case, which is the one a naive equality check would
  // wrongly treat as "the same trigger pressed again".
  const noSource: State = { mode: PLAYBACK, previousMode: RECORD, playbackSource: null };
  const b = reduce(noSource, { type: 'duration', seconds: 10, source: null }, held);
  assert.equal(b.state.mode, PLAYBACK);
  assert.deepEqual(types(b.effects), [STOP_PLAYBACK, START_PLAYBACK]);
});

test('a fresh entry into playback records the source and the mode it came from', () => {
  const fromRecord = reduce(
    { mode: RECORD, previousMode: STANDBY, playbackSource: null },
    { type: 'duration', seconds: 5, source: '1' },
    held,
  );
  assert.equal(fromRecord.state.mode, PLAYBACK);
  assert.equal(fromRecord.state.playbackSource, '1');
  assert.equal(fromRecord.state.previousMode, RECORD);

  // Entering with a source that matches a STALE playbackSource must still be
  // a fresh entry, because we were not in playback to begin with.
  const stale = reduce(
    { mode: RECORD, previousMode: STANDBY, playbackSource: '1' },
    { type: 'duration', seconds: 5, source: '1' },
    held,
  );
  assert.equal(stale.state.mode, PLAYBACK);
  assert.equal(stale.state.playbackSource, '1');
});

test('playbackSource is cleared by every transition that leaves playback', () => {
  const inPlayback: State = { mode: PLAYBACK, previousMode: RECORD, playbackSource: '2' };

  assert.equal(reduce(inPlayback, { type: 'back' }, held).state.playbackSource, null);
  assert.equal(reduce(inPlayback, { type: 'escape' }, held).state.playbackSource, null);
  assert.equal(reduce(inPlayback, { type: 'playbackEnded' }, held).state.playbackSource, null);
  assert.equal(reduce(inPlayback, { type: 'mode', to: RECORD }, held).state.playbackSource, null);
  assert.equal(reduce(inPlayback, { type: 'mode', to: STANDBY }, held).state.playbackSource, null);
});

test('the no-op paths leave playbackSource untouched', () => {
  // Naming the mode you are already in.
  const inRecord: State = { mode: RECORD, previousMode: STANDBY, playbackSource: '2' };
  const modeNoOp = reduce(inRecord, { type: 'mode', to: RECORD }, held);
  assert.deepEqual(modeNoOp.effects, []);
  assert.equal(modeNoOp.state.playbackSource, '2');

  // A playbackEnded that arrived late, after something else already moved on.
  const endedNoOp = reduce(inRecord, { type: 'playbackEnded' }, held);
  assert.deepEqual(endedNoOp.effects, []);
  assert.equal(endedNoOp.state.playbackSource, '2');
});

test('the same key can enter, exit, and enter again', () => {
  let state = initialState();
  state = reduce(state, { type: 'mode', to: RECORD }, noMic).state;
  assert.equal(state.mode, RECORD);

  state = reduce(state, { type: 'duration', seconds: 10, source: '2' }, held).state;
  assert.equal(state.mode, PLAYBACK);
  assert.equal(state.playbackSource, '2');

  state = reduce(state, { type: 'duration', seconds: 10, source: '2' }, held).state;
  assert.equal(state.mode, RECORD);
  assert.equal(state.playbackSource, null);

  // Proves the source was genuinely cleared rather than left stale — a third
  // press has to be a fresh entry, not another exit.
  state = reduce(state, { type: 'duration', seconds: 10, source: '2' }, held).state;
  assert.equal(state.mode, PLAYBACK);
  assert.equal(state.playbackSource, '2');
});
