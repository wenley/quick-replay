// getUserMedia with a bounded retry.
//
// Some audio interfaces abort the first attempt to open them and then work
// immediately afterwards. Observed with a RØDE NT1 5th Gen on Firefox: arming
// failed with AbortError, and a diagnostic pass moments later opened the exact
// same constraints successfully on the first try — same device, same request,
// different outcome. AbortError specifically means permission was granted and
// the hardware is fine but the device could not be opened anyway, which is a
// transient condition worth retrying rather than reporting.

import { describeError } from './diagnostics.ts';

/**
 * Only these are retried. A denied permission or an impossible constraint is
 * a settled answer — asking again just produces the same refusal, and in the
 * NotAllowedError case it would re-prompt and pester the user.
 */
const RETRYABLE = new Set(['AbortError', 'NotReadableError']);

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 250;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RetryNotice {
  attempt: number;
  ofAttempts: number;
  errorName: string;
}

/**
 * @param onRetry - called before each retry, so a caller can surface or record
 *   the fact that the first open failed. Never called on the final failure.
 */
export async function getUserMediaWithRetry(
  constraints: MediaStreamConstraints,
  onRetry?: (notice: RetryNotice) => void,
): Promise<MediaStream> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      lastError = err;
      const { name } = describeError(err);
      if (!RETRYABLE.has(name) || attempt === MAX_ATTEMPTS) throw err;
      onRetry?.({ attempt, ofAttempts: MAX_ATTEMPTS, errorName: name });
      await delay(RETRY_DELAY_MS);
    }
  }

  // Unreachable: the loop either returns or throws.
  throw lastError;
}
