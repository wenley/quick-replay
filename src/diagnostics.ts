// Diagnostics for microphone acquisition failures.
//
// Everything interesting fails in the browser, so this collects what the
// terminal cannot see and POSTs it to the server, which prints it. Nothing
// here touches audio SAMPLES — only device metadata, the constraints we
// asked for, the settings we got back, and the error. The server is bound to
// 127.0.0.1, so a report reaches the terminal that started it and nowhere
// else.

import { MIC_CONSTRAINTS } from './config.ts';

// Must match DIAG_PATH in server.ts.
const DIAG_PATH = '/__diag';

export interface ErrorInfo {
  name: string;
  message: string;
  /** Present on OverconstrainedError: which constraint could not be met. */
  constraint?: string;
}

/**
 * getUserMedia rejects with a DOMException whose `name` is the part that
 * actually identifies the failure — NotAllowedError, NotReadableError,
 * OverconstrainedError, AbortError. The `message` alone ("The operation was
 * aborted") says almost nothing, which is why this pulls out both.
 */
export function describeError(err: unknown): ErrorInfo {
  if (err instanceof DOMException) {
    const info: ErrorInfo = { name: err.name, message: err.message };
    // OverconstrainedError carries the offending constraint's name.
    const constraint = (err as DOMException & { constraint?: unknown }).constraint;
    if (typeof constraint === 'string' && constraint !== '') info.constraint = constraint;
    return info;
  }
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: 'Unknown', message: String(err) };
}

interface LadderStep {
  label: string;
  constraints: MediaStreamConstraints;
}

interface LadderResult {
  label: string;
  constraints: MediaStreamConstraints;
  ok: boolean;
  /** What the device actually gave us, when it opened. */
  settings?: MediaTrackSettings;
  trackLabel?: string;
  error?: ErrorInfo;
}

// Each step drops one thing from the request, so the first one that succeeds
// names the constraint the device is rejecting.
const LADDER: LadderStep[] = [
  {
    label: 'full — exactly what the app asks for',
    constraints: MIC_CONSTRAINTS,
  },
  {
    label: 'without channelCount: 1',
    constraints: {
      audio: { echoCancellation: false, autoGainControl: false, noiseSuppression: false },
    },
  },
  {
    label: 'without the three processing flags',
    constraints: { audio: { channelCount: 1 } },
  },
  {
    label: 'bare audio: true',
    constraints: { audio: true },
  },
];

async function tryConstraints(label: string, constraints: MediaStreamConstraints): Promise<LadderResult> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    const track = stream.getAudioTracks()[0];
    const result: LadderResult = {
      label,
      constraints,
      ok: true,
      settings: track ? track.getSettings() : undefined,
      trackLabel: track ? track.label : undefined,
    };
    // Release immediately — the next rung needs the device, and leaving it
    // open would hold the OS mic indicator lit for no reason.
    stream.getTracks().forEach((t) => t.stop());
    return result;
  } catch (err) {
    return { label, constraints, ok: false, error: describeError(err) };
  }
}

async function listAudioDevices(): Promise<unknown[]> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'audioinput' || d.kind === 'audiooutput')
      .map((d) => ({
        kind: d.kind,
        // Labels are empty until permission has been granted at least once.
        label: d.label || '(hidden — no permission granted yet)',
        deviceId: d.deviceId === 'default' ? 'default' : `${d.deviceId.slice(0, 8)}…`,
        groupId: `${d.groupId.slice(0, 8)}…`,
      }));
  } catch (err) {
    return [{ error: describeError(err) }];
  }
}

function describeAudioContext(audioCtx: AudioContext | null): unknown {
  if (!audioCtx) return null;
  return {
    sampleRate: audioCtx.sampleRate,
    state: audioCtx.state,
    baseLatency: audioCtx.baseLatency,
    outputLatency: typeof audioCtx.outputLatency === 'number' ? audioCtx.outputLatency : null,
  };
}

export interface DiagnosticOptions {
  /** What the app was doing when this was collected. */
  stage: string;
  audioCtx: AudioContext | null;
  /** The failure that prompted this, if any. */
  error?: unknown;
  /** Walk the constraint ladder. Off for a plain success report. */
  runLadder: boolean;
  /** Anything extra worth recording alongside the standard fields. */
  note?: unknown;
  /** The currently selected input device, if any (null = system default). */
  selectedDeviceId?: string | null;
}

/**
 * Builds the report. The ladder is the useful part: it re-requests the mic
 * with progressively fewer constraints, so whichever rung first succeeds
 * identifies what the device would not accept.
 */
export async function collectDiagnostics(options: DiagnosticOptions): Promise<Record<string, unknown>> {
  const report: Record<string, unknown> = {
    stage: options.stage,
    userAgent: navigator.userAgent,
    audioContext: describeAudioContext(options.audioCtx),
    requestedConstraints: MIC_CONSTRAINTS,
    supportedConstraints: navigator.mediaDevices.getSupportedConstraints(),
    devices: await listAudioDevices(),
  };

  if (options.selectedDeviceId !== undefined) {
    report.selectedDeviceId = options.selectedDeviceId;
  }

  if (options.error !== undefined) {
    report.error = describeError(options.error);
  }

  if (options.note !== undefined) {
    report.note = options.note;
  }

  if (options.runLadder) {
    const results: LadderResult[] = [];
    for (const step of LADDER) {
      results.push(await tryConstraints(step.label, step.constraints));
    }

    // If every generic rung failed, the device itself may be the problem
    // rather than the constraints — try each input by id.
    if (results.every((r) => !r.ok)) {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        for (const d of devices.filter((x) => x.kind === 'audioinput')) {
          results.push(await tryConstraints(
            `device "${d.label || d.deviceId.slice(0, 8)}" with no other constraints`,
            { audio: { deviceId: { exact: d.deviceId } } },
          ));
        }
      } catch { /* enumerateDevices already reported above */ }
    }

    report.constraintLadder = results;
    // Re-enumerate now. The list gathered above was taken before any
    // successful request, and browsers withhold device LABELS until
    // permission has been granted at least once — so the first pass is
    // usually a list of anonymous ids. If any rung succeeded, this second
    // pass has real names in it.
    report.devicesAfterPermission = await listAudioDevices();

    const firstOk = results.find((r) => r.ok);
    report.verdict = firstOk
      ? `First working request: "${firstOk.label}"`
      : 'Nothing worked — no rung of the ladder could open an input device.';
  }

  return report;
}

/** Prints locally and ships to the server's terminal. Never throws. */
export async function reportDiagnostics(options: DiagnosticOptions): Promise<void> {
  let report: Record<string, unknown>;
  try {
    report = await collectDiagnostics(options);
  } catch (err) {
    report = { stage: options.stage, collectionFailed: describeError(err) };
  }

  console.warn('quick-replay diagnostics:', report);

  try {
    await fetch(DIAG_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
    });
  } catch (err) {
    console.warn('quick-replay: could not send diagnostics to the server', err);
  }
}

// Lets a report be triggered by hand from the devtools console at any time,
// not only when arming has failed.
declare global {
  interface Window {
    quickReplayDiagnostics?: (audioCtx?: AudioContext | null) => Promise<void>;
  }
}

export function installDiagnosticsHook(getAudioCtx: () => AudioContext | null): void {
  window.quickReplayDiagnostics = (audioCtx?: AudioContext | null) =>
    reportDiagnostics({
      stage: 'manual (window.quickReplayDiagnostics)',
      audioCtx: audioCtx ?? getAudioCtx(),
      runLadder: true,
    });
}
