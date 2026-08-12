// --- small utils ---------------------------------------------------------

export function formatMinSec(totalSeconds: number): string {
  const safe = Math.max(0, totalSeconds);
  const m = Math.floor(safe / 60);
  const s = Math.floor(safe % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatSpeed(value: number): string {
  return `${value.toFixed(2)}x`;
}
