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

export type Mode = typeof STANDBY | typeof RECORD | typeof PLAYBACK;

// The two modes you can ask for by name. Playback is never entered by naming
// it — only by asking for a duration — so it is absent here by construction
// rather than by convention.
export type NamedMode = typeof STANDBY | typeof RECORD;

export type Effect =
  | { type: typeof ACQUIRE_MIC }
  | { type: typeof RELEASE_MIC }
  | { type: typeof START_CAPTURE }
  | { type: typeof STOP_CAPTURE }
  | { type: typeof FLUSH }
  | { type: typeof START_PLAYBACK; seconds: number }
  | { type: typeof STOP_PLAYBACK };

export type Event =
  | { type: 'mode'; to: NamedMode }
  | { type: 'duration'; seconds: number }
  | { type: 'playbackEnded' }
  | { type: 'back' }
  | { type: 'escape' };

export interface State {
  mode: Mode;
  previousMode: Mode;
}

/** What the interpreter knows that the reducer cannot work out for itself. */
export interface Context {
  micHeld: boolean;
}

export interface Result {
  state: State;
  effects: Effect[];
}

export function initialState(): State {
  return { mode: STANDBY, previousMode: STANDBY };
}

// --- entry-effect builders -------------------------------------------------
// Each of these describes the effects for ENTERING a mode. `fromPlayback`
// controls whether a `stopPlayback` needs to be emitted first - callers that
// already emitted (or don't need) their own `stopPlayback` pass `false`.

function standbyEntryEffects(fromPlayback: boolean): Effect[] {
  const effects: Effect[] = [];
  if (fromPlayback) effects.push({ type: STOP_PLAYBACK });
  effects.push({ type: STOP_CAPTURE }, { type: FLUSH }, { type: RELEASE_MIC });
  return effects;
}

function recordEntryEffects(fromPlayback: boolean, context: Context): Effect[] {
  const effects: Effect[] = [];
  if (fromPlayback) effects.push({ type: STOP_PLAYBACK });
  // The mic is only (re)acquired if we don't already hold it - this is what
  // keeps record -> playback -> record gapless.
  if (!context.micHeld) effects.push({ type: ACQUIRE_MIC });
  effects.push({ type: START_CAPTURE });
  return effects;
}

function playbackEntryEffects(seconds: number): Effect[] {
  return [{ type: STOP_CAPTURE }, { type: FLUSH }, { type: START_PLAYBACK, seconds }];
}

// Entering whichever mode a playback should fall back to.
function returnEntryEffects(target: Mode, context: Context): Effect[] {
  return target === RECORD ? recordEntryEffects(false, context) : standbyEntryEffects(false);
}

// --- event handlers ----------------------------------------------------

function handleMode(state: State, to: NamedMode, context: Context): Result {
  // Naming the mode you're already in is a no-op. `to` can never be
  // 'playback', so this can't spuriously fire while a replay is running.
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

  return {
    state: { mode: STANDBY, previousMode: state.previousMode },
    effects: standbyEntryEffects(fromPlayback),
  };
}

function handleDuration(state: State, seconds: number): Result {
  if (state.mode === PLAYBACK) {
    // Re-trigger. previousMode must NOT change here - it still points at
    // whatever mode we were in before the *original* entry into playback.
    return {
      state: { mode: PLAYBACK, previousMode: state.previousMode },
      effects: [{ type: STOP_PLAYBACK }, { type: START_PLAYBACK, seconds }],
    };
  }

  // Fresh entry into playback - capture the current mode as the one to return
  // to, but only at this moment of entry.
  return {
    state: { mode: PLAYBACK, previousMode: state.mode },
    effects: playbackEntryEffects(seconds),
  };
}

function handlePlaybackEnded(state: State, context: Context): Result {
  if (state.mode !== PLAYBACK) {
    // Arrived late after a supersede (e.g. escape/back already moved us on).
    return { state: { ...state }, effects: [] };
  }

  const target = state.previousMode;
  return {
    state: { mode: target, previousMode: state.previousMode },
    effects: returnEntryEffects(target, context),
  };
}

function handleBack(state: State, context: Context): Result {
  if (state.mode !== PLAYBACK) {
    // Outside playback, Space is a Record/Standby toggle — the single key
    // you can hit to start or stop capturing without aiming.
    return handleMode(state, state.mode === RECORD ? STANDBY : RECORD, context);
  }

  const target = state.previousMode;
  return {
    state: { mode: target, previousMode: state.previousMode },
    effects: [{ type: STOP_PLAYBACK }, ...returnEntryEffects(target, context)],
  };
}

function handleEscape(state: State, context: Context): Result {
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

export function reduce(state: State, event: Event, context: Context): Result {
  switch (event.type) {
    case 'mode':
      return handleMode(state, event.to, context);
    case 'duration':
      return handleDuration(state, event.seconds);
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
