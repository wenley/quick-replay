// DOM element registry and small status-chrome helpers for quick-replay.
//
// Owns every `document.getElementById` lookup used by the app, plus the
// small status widgets (flash messages, arm/runtime errors, the focus
// banner) that write directly to those elements.

import { describeError } from './diagnostics.ts';

// --- DOM refs ------------------------------------------------------------

function byId(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function inputById(id: string): HTMLInputElement | null {
  return document.getElementById(id) as HTMLInputElement | null;
}

function buttonById(id: string): HTMLButtonElement | null {
  return document.getElementById(id) as HTMLButtonElement | null;
}

function selectById(id: string): HTMLSelectElement | null {
  return document.getElementById(id) as HTMLSelectElement | null;
}

export interface Elements {
  armScreen: HTMLElement | null;
  armButton: HTMLButtonElement | null;
  armError: HTMLElement | null;
  mainUi: HTMLElement | null;
  modeIndicator: HTMLElement | null;
  modeLabel: HTMLElement | null;
  bufferText: HTMLElement | null;
  timelineTicks: HTMLElement | null;
  timelineTrack: HTMLElement | null;
  timelineAxis: HTMLElement | null;
  timelineHighlight: HTMLElement | null;
  timelinePlaying: HTMLElement | null;
  levelMeterContainer: HTMLElement | null;
  levelMeterFill: HTMLElement | null;
  playbackStatus: HTMLElement | null;
  playbackStatusText: HTMLElement | null;
  playbackProgressFill: HTMLElement | null;
  flashMessage: HTMLElement | null;
  focusBanner: HTMLElement | null;
  gainSlider: HTMLInputElement | null;
  gainDb: HTMLElement | null;
  gainMult: HTMLElement | null;
  gainClipWarning: HTMLElement | null;
  speedSlider: HTMLInputElement | null;
  speedValue: HTMLElement | null;
  deviceSelect: HTMLSelectElement | null;
}

export const el: Elements = {
  armScreen: byId('arm-screen'),
  armButton: buttonById('arm-button'),
  armError: byId('arm-error'),
  mainUi: byId('main-ui'),
  modeIndicator: byId('mode-indicator'),
  modeLabel: byId('mode-label'),
  bufferText: byId('buffer-text'),
  timelineTicks: byId('timeline-ticks'),
  timelineTrack: byId('timeline-track'),
  timelineAxis: byId('timeline-axis'),
  timelineHighlight: byId('timeline-highlight'),
  timelinePlaying: byId('timeline-playing'),
  levelMeterContainer: byId('level-meter-container'),
  levelMeterFill: byId('level-meter-fill'),
  playbackStatus: byId('playback-status'),
  playbackStatusText: byId('playback-status-text'),
  playbackProgressFill: byId('playback-progress-fill'),
  flashMessage: byId('flash-message'),
  focusBanner: byId('focus-banner'),
  gainSlider: inputById('gain-slider'),
  gainDb: byId('gain-db'),
  gainMult: byId('gain-mult'),
  gainClipWarning: byId('gain-clip-warning'),
  speedSlider: inputById('speed-slider'),
  speedValue: byId('speed-value'),
  deviceSelect: selectById('device-select'),
};

// --- small utils ---------------------------------------------------------

let flashTimer: number | undefined;
export function flashMessage(text: string): void {
  if (!el.flashMessage) return;
  const flashEl = el.flashMessage;
  flashEl.textContent = text;
  flashEl.classList.add('visible');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    flashEl.classList.remove('visible');
  }, 2000);
}

export function showArmError(err: unknown): void {
  console.error('quick-replay: arm failed', err);
  if (el.armError) {
    // Lead with the error's NAME. getUserMedia rejects with a DOMException
    // whose message is often uselessly vague ("The operation was aborted"),
    // while the name — AbortError, NotReadableError, OverconstrainedError —
    // is what actually says which kind of failure this was.
    const { name, message } = describeError(err);
    el.armError.textContent =
      `Failed to start: ${name} — ${message}. ` +
      `A diagnostic report has been printed in the terminal running the server.`;
    el.armError.classList.add('visible');
  }
}

export function showRuntimeError(message: string): void {
  console.error('quick-replay:', message);
  flashMessage(message);
}

// --- focus warning -------------------------------------------------------

export function setFocusBannerVisible(visible: boolean): void {
  if (!el.focusBanner) return;
  el.focusBanner.classList.toggle('visible', visible);
}
