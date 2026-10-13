// How a download is getting on: speed and time left from successive readings of the bytes
// received. Plain TypeScript (no React Native), shared by the phone apps and the desktop app.

/** A download's speed so far, smoothed so the time left doesn't jump about with every reading. */
export type Rate = { bytes: number; time: number; perSecond: number };

/** How much each new reading counts (the rest is the speed so far). */
const SMOOTHING = 0.3;

/**
 * The speed after a new reading of `bytes` received at `time` (milliseconds). Readings closer
 * together than a quarter second are left out: too short to measure anything.
 */
export function nextRate(previous: Rate | undefined, bytes: number, time: number): Rate {
  if (!previous || bytes < previous.bytes) return { bytes, time, perSecond: 0 };
  const seconds = (time - previous.time) / 1000;
  if (seconds < 0.25) return previous;
  const now = (bytes - previous.bytes) / seconds;
  const perSecond = previous.perSecond > 0 ? previous.perSecond + SMOOTHING * (now - previous.perSecond) : now;
  return { bytes, time, perSecond };
}

/** Seconds left at this speed, or null while that can't be told (size or speed unknown). */
export function secondsLeft(received: number, total: number, rate: Rate | undefined): number | null {
  if (!rate || rate.perSecond <= 0 || total <= 0 || received >= total) return null;
  return (total - received) / rate.perSecond;
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function formatSpeed(rate: Rate | undefined): string {
  return rate && rate.perSecond >= 1 ? `${formatBytes(rate.perSecond)}/s` : '';
}

/** "8 s left", "3 min left", "1 h 5 min left"; rounded up so it never says 0 while unfinished. */
export function formatTimeLeft(seconds: number | null): string {
  if (seconds === null || !isFinite(seconds)) return '';
  const s = Math.max(1, Math.ceil(seconds));
  if (s < 60) return `${s} s left`;
  const minutes = Math.ceil(s / 60);
  if (minutes < 60) return `${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min left` : `${hours} h left`;
}

/** "4.2 MB of 18 MB · 1.3 MB/s · 11 s left" (the parts that are known). */
export function progressText(received: number, total: number, rate: Rate | undefined): string {
  const amount = total > 0 ? `${formatBytes(received) || '0 B'} of ${formatBytes(total)}` : formatBytes(received) || 'Starting…';
  return [amount, formatSpeed(rate), formatTimeLeft(secondsLeft(received, total, rate))].filter(Boolean).join(' · ');
}

/** How far along a download is (0 to 1), or null when its size isn't known. */
export function fraction(received: number, total: number): number | null {
  return total > 0 ? Math.min(1, Math.max(0, received / total)) : null;
}
