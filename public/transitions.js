// Pure reducer for the quick-replay 3-mode state machine (standby / record /
// playback). No side effects happen here - `reduce` only decides WHAT should
// happen; the caller interprets the returned `effects` against the real
// audio graph (mic stream, capture node, playback source, etc).

export const STANDBY = 'standby';
export const RECORD = 'record';
export const PLAYBACK = 'playback';

export const ACQUIRE_MIC = 'acquireMic';
export const RELEASE_MIC = 'releaseMic';
export const START_CAPTURE = 'startCapture';
export const STOP_CAPTURE = 'stopCapture';
export const FLUSH = 'flush';
export const START_PLAYBACK = 'startPlayback';
export const STOP_PLAYBACK = 'stopPlayback';

function effect(type, extra) {
  return extra ? { type, ...extra } : { type };
}

/** @returns {{ mode: string, previousMode: string }} */
export function initialState() {
  return { mode: STANDBY, previousMode: STANDBY };
}

// --- entry-effect builders -------------------------------------------------
// Each of these describes the effects for ENTERING a mode. `fromPlayback`
// controls whether a `stopPlayback` needs to be emitted first - callers that
// already emitted (or don't need) their own `stopPlayback` pass `false`.

function standbyEntryEffects(fromPlayback) {
  const effects = [];
  if (fromPlayback) effects.push(effect(STOP_PLAYBACK));
  effects.push(effect(STOP_CAPTURE), effect(FLUSH), effect(RELEASE_MIC));
  return effects;
}

function recordEntryEffects(fromPlayback, context) {
  const effects = [];
  if (fromPlayback) effects.push(effect(STOP_PLAYBACK));
  // The mic is only (re)acquired if we don't already hold it - this is what
  // keeps record -> playback -> record gapless.
  if (!context.micHeld) effects.push(effect(ACQUIRE_MIC));
  effects.push(effect(START_CAPTURE));
  return effects;
}

function playbackEntryEffects(seconds) {
  return [effect(STOP_CAPTURE), effect(FLUSH), effect(START_PLAYBACK, { seconds })];
}

// --- event handlers ----------------------------------------------------

function handleMode(state, to, context) {
  // Rule 8: naming the mode you're already in is a no-op. (This can never
  // spuriously trigger from playback since `to` is only ever 'record' or
  // 'standby' here - satisfying the "exception while in playback" clause.)
  if (state.mode === to) {
    return { state: { ...state }, effects: [] };
  }

  const fromPlayback = state.mode === PLAYBACK;

  if (to === RECORD) {
    return {
      state: { mode: RECORD, previousMode: state.previousMode },
      effects: recordEntryEffects(fromPlayback, context),
    };
  }

  // to === STANDBY
  return {
    state: { mode: STANDBY, previousMode: state.previousMode },
    effects: standbyEntryEffects(fromPlayback),
  };
}

function handleDuration(state, seconds, context) {
  if (state.mode === PLAYBACK) {
    // Rule 4: re-trigger. previousMode must NOT change here - it still
    // points at whatever mode we were in before the *original* entry into
    // playback.
    return {
      state: { mode: PLAYBACK, previousMode: state.previousMode },
      effects: [effect(STOP_PLAYBACK), effect(START_PLAYBACK, { seconds })],
    };
  }

  // Rule 3: fresh entry into playback - capture the current mode as the one
  // to return to, but only at this moment of entry.
  return {
    state: { mode: PLAYBACK, previousMode: state.mode },
    effects: playbackEntryEffects(seconds),
  };
}

function handlePlaybackEnded(state, context) {
  if (state.mode !== PLAYBACK) {
    // Arrived late after a supersede (e.g. escape/back already moved us on).
    return { state: { ...state }, effects: [] };
  }

  const target = state.previousMode;
  const effects = target === RECORD
    ? recordEntryEffects(false, context)
    : standbyEntryEffects(false);

  return { state: { mode: target, previousMode: state.previousMode }, effects };
}

function handleBack(state, context) {
  if (state.mode !== PLAYBACK) {
    return { state: { ...state }, effects: [] };
  }

  const target = state.previousMode;
  const entryEffects = target === RECORD
    ? recordEntryEffects(false, context)
    : standbyEntryEffects(false);

  return {
    state: { mode: target, previousMode: state.previousMode },
    effects: [effect(STOP_PLAYBACK), ...entryEffects],
  };
}

function handleEscape(state, context) {
  if (state.mode === PLAYBACK) {
    return {
      state: { mode: STANDBY, previousMode: state.previousMode },
      effects: standbyEntryEffects(true),
    };
  }

  // Outside playback, escape behaves like a `mode: 'standby'` event
  // (including the already-in-standby no-op).
  return handleMode(state, STANDBY, context);
}

/**
 * @param {{ mode: string, previousMode: string }} state
 * @param {object} event
 * @param {{ micHeld: boolean }} context
 * @returns {{ state: { mode: string, previousMode: string }, effects: object[] }}
 */
export function reduce(state, event, context) {
  switch (event.type) {
    case 'mode':
      return handleMode(state, event.to, context);
    case 'duration':
      return handleDuration(state, event.seconds, context);
    case 'playbackEnded':
      return handlePlaybackEnded(state, context);
    case 'back':
      return handleBack(state, context);
    case 'escape':
      return handleEscape(state, context);
    default:
      return { state: { ...state }, effects: [] };
  }
}
