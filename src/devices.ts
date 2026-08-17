// Audio input device picker: lists available mic inputs, persists the
// choice across reloads, and keeps the <select> in sync as devices are
// plugged or unplugged.

import { DEVICE_STORAGE_KEY, micConstraints } from './config.ts';
import { el, flashMessage } from './dom.ts';

function loadStoredDeviceId(): string | null {
  try {
    return localStorage.getItem(DEVICE_STORAGE_KEY);
  } catch { /* private mode / storage disabled — fall through to default */ }
  return null;
}

function storeDeviceId(deviceId: string | null): void {
  try {
    if (deviceId === null) {
      localStorage.removeItem(DEVICE_STORAGE_KEY);
    } else {
      localStorage.setItem(DEVICE_STORAGE_KEY, deviceId);
    }
  } catch { /* ignore */ }
}

export interface DevicePicker {
  /** The chosen device, or null for "system default". */
  readonly deviceId: string | null;
  /** Constraints for the current selection. */
  constraints(): MediaStreamConstraints;
  /** Re-read the device list and repopulate the <select>. */
  refresh(): Promise<void>;
}

export function createDevicePicker(deps: { onChange: () => void }): DevicePicker {
  let deviceId: string | null = loadStoredDeviceId();

  // Rebuilds the <select> from the current device list, re-selecting the
  // stored choice if it is still present. Labels are blank until mic
  // permission has been granted at least once, hence the numbered fallback.
  function populate(devices: MediaDeviceInfo[]): void {
    const select = el.deviceSelect;
    if (!select) return;

    select.textContent = '';

    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = 'System default';
    select.appendChild(defaultOption);

    devices.forEach((device, index) => {
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label || `Input ${index + 1}`;
      select.appendChild(option);
    });

    // The stored device may have been unplugged since last time — don't
    // silently keep pointing at a dead id.
    const stillPresent = deviceId !== null && devices.some((d) => d.deviceId === deviceId);
    if (deviceId !== null && !stillPresent) {
      deviceId = null;
      storeDeviceId(null);
      flashMessage('input device no longer available — using system default');
    }

    select.value = deviceId ?? '';
  }

  async function refresh(): Promise<void> {
    const all = await navigator.mediaDevices.enumerateDevices();
    const inputs = all.filter((d) => d.kind === 'audioinput');
    populate(inputs);
  }

  if (el.deviceSelect) {
    const select = el.deviceSelect;
    select.addEventListener('change', () => {
      deviceId = select.value === '' ? null : select.value;
      storeDeviceId(deviceId);
      deps.onChange();
      // Hand focus back after a click, same as the gain and speed sliders,
      // so the duration keys keep working without clicking away first.
      select.blur();
    });
  }

  // Plugging or unplugging a device updates the list live.
  navigator.mediaDevices.addEventListener('devicechange', () => { void refresh(); });

  return {
    get deviceId(): string | null {
      return deviceId;
    },
    constraints(): MediaStreamConstraints {
      return micConstraints(deviceId);
    },
    refresh,
  };
}
