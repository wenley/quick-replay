// --- config ------------------------------------------------------------

export interface Duration {
  key: string;
  seconds: number;
  label: string;
}

export const DURATIONS: Duration[] = [
  { key: '1', seconds: 5, label: '5s' },
  { key: '2', seconds: 10, label: '10s' },
  { key: '3', seconds: 30, label: '30s' },
  { key: '4', seconds: 60, label: '1m' },
  { key: '5', seconds: 120, label: '2m' },
  { key: '6', seconds: 300, label: '5m' },
];

function readMaxSeconds(): number {
  const raw = document.body.dataset.maxLookbackSeconds;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.warn(
      `quick-replay: __MAX_LOOKBACK_SECONDS__ placeholder was not substituted ` +
      `(got "${raw}"). This page was probably opened directly instead of via ` +
      `the server. Falling back to 300s.`
    );
    return 300;
  }
  return value;
}

export const MAX_SECONDS = readMaxSeconds();

export const DEVICE_STORAGE_KEY = 'quick-replay:input-device';

/** Capture constraints, optionally pinned to a specific input device. */
export function micConstraints(deviceId: string | null): MediaStreamConstraints {
  return {
    audio: {
      echoCancellation: false,
      autoGainControl: false,
      noiseSuppression: false,
      channelCount: 1,
      ...(deviceId !== null ? { deviceId: { exact: deviceId } } : {}),
    },
  };
}

export const MIC_CONSTRAINTS: MediaStreamConstraints = micConstraints(null);
