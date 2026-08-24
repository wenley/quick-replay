// Error description shared by capture and DOM status helpers.

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
