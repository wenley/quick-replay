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
} from '../public/transitions.js';

function types(effects) {
  return effects.map((e) => e.type);
}

test('previousMode is set on entry to playback and survives a duration re-trigger mid-playback', () => {
  let state = { mode: RECORD, previousMode: STANDBY };
  const held = { micHeld: true };

  let result = reduce(state, { type: 'duration', seconds: 2 }, held);
  assert.equal(result.state.mode, PLAYBACK);
  assert.equal(result.state.previousMode, RECORD);

  // Re-trigger while already in playback must NOT touch previousMode.
  result = reduce(result.state, { type: 'duration', seconds: 5 }, held);
  assert.equal(result.state.mode, PLAYBACK);
  assert.equal(result.state.previousMode, RECORD);
});

test('playbackEnded from record->playback returns to record; from standby->playback returns to standby', () => {
  const held = { micHeld: true };

  let fromRecord = reduce({ mode: RECORD, previousMode: STANDBY }, { type: 'duration', seconds: 2 }, held);
  let ended = reduce(fromRecord.state, { type: 'playbackEnded' }, held);
  assert.equal(ended.state.mode, RECORD);

  let fromStandby = reduce({ mode: STANDBY, previousMode: STANDBY }, { type: 'duration', seconds: 2 }, held);
  let ended2 = reduce(fromStandby.state, { type: 'playbackEnded' }, held);
  assert.equal(ended2.state.mode, STANDBY);
});

test('escape during playback lands in standby even when previousMode is record', () => {
  const state = { mode: PLAYBACK, previousMode: RECORD };
  const result = reduce(state, { type: 'escape' }, { micHeld: true });
  assert.equal(result.state.mode, STANDBY);
  assert.deepEqual(types(result.effects), [STOP_PLAYBACK, STOP_CAPTURE, FLUSH, RELEASE_MIC]);
});

test('back during playback returns to previousMode', () => {
  const state = { mode: PLAYBACK, previousMode: RECORD };
  const result = reduce(state, { type: 'back' }, { micHeld: true });
  assert.equal(result.state.mode, RECORD);
  assert.deepEqual(types(result.effects), [STOP_PLAYBACK, START_CAPTURE]);

  const state2 = { mode: PLAYBACK, previousMode: STANDBY };
  const result2 = reduce(state2, { type: 'back' }, { micHeld: true });
  assert.equal(result2.state.mode, STANDBY);
  assert.deepEqual(types(result2.effects), [STOP_PLAYBACK, STOP_CAPTURE, FLUSH, RELEASE_MIC]);
});

test('entering record emits acquireMic only when context.micHeld is false', () => {
  const withoutMic = reduce({ mode: STANDBY, previousMode: STANDBY }, { type: 'mode', to: RECORD }, { micHeld: false });
  assert.deepEqual(types(withoutMic.effects), [ACQUIRE_MIC, START_CAPTURE]);

  const withMic = reduce({ mode: STANDBY, previousMode: STANDBY }, { type: 'mode', to: RECORD }, { micHeld: true });
  assert.deepEqual(types(withMic.effects), [START_CAPTURE]);
});

test('entering standby always emits releaseMic; entering playback never emits releaseMic', () => {
  const toStandby = reduce({ mode: RECORD, previousMode: STANDBY }, { type: 'mode', to: STANDBY }, { micHeld: true });
  assert.ok(types(toStandby.effects).includes(RELEASE_MIC));

  const toPlayback = reduce({ mode: RECORD, previousMode: STANDBY }, { type: 'duration', seconds: 3 }, { micHeld: true });
  assert.ok(!types(toPlayback.effects).includes(RELEASE_MIC));
});

test('re-trigger emits stopPlayback before startPlayback and carries the new seconds', () => {
  const inPlayback = { mode: PLAYBACK, previousMode: RECORD };
  const result = reduce(inPlayback, { type: 'duration', seconds: 7 }, { micHeld: true });
  assert.deepEqual(types(result.effects), [STOP_PLAYBACK, START_PLAYBACK]);
  const startEffect = result.effects.find((e) => e.type === START_PLAYBACK);
  assert.equal(startEffect.seconds, 7);
});

test('playbackEnded outside playback is a no-op', () => {
  const state = { mode: RECORD, previousMode: STANDBY };
  const result = reduce(state, { type: 'playbackEnded' }, { micHeld: true });
  assert.equal(result.state.mode, RECORD);
  assert.deepEqual(result.effects, []);
});

test('reduce does not mutate the input state object', () => {
  const state = Object.freeze({ mode: RECORD, previousMode: STANDBY });
  assert.doesNotThrow(() => reduce(state, { type: 'duration', seconds: 3 }, { micHeld: true }));
  assert.equal(state.mode, RECORD);
  assert.equal(state.previousMode, STANDBY);
});

test('initialState returns standby/standby', () => {
  assert.deepEqual(initialState(), { mode: STANDBY, previousMode: STANDBY });
});

test('a mode event naming the current mode is a no-op', () => {
  const state = { mode: RECORD, previousMode: STANDBY };
  const result = reduce(state, { type: 'mode', to: RECORD }, { micHeld: true });
  assert.equal(result.state.mode, RECORD);
  assert.deepEqual(result.effects, []);
});

test('back in record toggles to standby, releasing the mic', () => {
  const state = { mode: RECORD, previousMode: STANDBY };
  const result = reduce(state, { type: 'back' }, { micHeld: true });
  assert.equal(result.state.mode, STANDBY);
  assert.deepEqual(types(result.effects), [STOP_CAPTURE, FLUSH, RELEASE_MIC]);
});

test('back in standby toggles to record, acquiring the mic', () => {
  const state = { mode: STANDBY, previousMode: STANDBY };
  const result = reduce(state, { type: 'back' }, { micHeld: false });
  assert.equal(result.state.mode, RECORD);
  assert.deepEqual(types(result.effects), [ACQUIRE_MIC, START_CAPTURE]);
});

test('back still returns to previous mode while in playback (not a toggle)', () => {
  const state = { mode: PLAYBACK, previousMode: RECORD };
  const result = reduce(state, { type: 'back' }, { micHeld: true });
  assert.equal(result.state.mode, RECORD);
  assert.deepEqual(types(result.effects), [STOP_PLAYBACK, START_CAPTURE]);
});
