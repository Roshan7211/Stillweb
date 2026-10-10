import { useEffect, useRef, useState } from 'react';

/**
 * Keeps something on screen a little longer than it is wanted, so it can animate out.
 * `value` is what to show (null for nothing). Returns the value to draw, which lags behind
 * by `exitMs` when `value` becomes null, and whether it is on its way out.
 */
export function usePresence<T>(value: T | null, exitMs: number): { shown: T | null; leaving: boolean } {
  const [shown, setShown] = useState<T | null>(value);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    window.clearTimeout(timer.current);
    if (value !== null) {
      setShown(value);
      return;
    }
    timer.current = window.setTimeout(() => setShown(null), exitMs);
    return () => window.clearTimeout(timer.current);
  }, [value, exitMs]);

  // While a new value is on its way in through the effect, draw it already.
  const current = value ?? shown;
  return { shown: current, leaving: value === null && current !== null };
}
