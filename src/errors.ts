/**
 * App-wide error handling. Errors while drawing a screen are caught by ErrorBoundary; this
 * covers the rest (taps, timers, native callbacks), which in a release build would otherwise
 * close the app. Stillweb keeps running and shows a notice instead.
 */
type Listener = (error: Error) => void;

const listeners = new Set<Listener>();
let installed = false;
let appReady = false;

export function installGlobalErrorHandler(): void {
  if (installed || typeof ErrorUtils === 'undefined') return;
  installed = true;
  const previous = ErrorUtils.getGlobalHandler();
  ErrorUtils.setGlobalHandler((error: unknown, isFatal?: boolean) => {
    const err = error instanceof Error ? error : new Error(String(error));
    // Development keeps the red error screen; before the app has drawn anything there is
    // nothing to fall back to.
    if (__DEV__ || !appReady) return previous(err, isFatal);
    console.error(err);
    listeners.forEach((listener) => listener(err));
  });
}

/** Called once the browser is on screen: from then on errors are shown, not fatal. */
export function markAppReady(): void {
  appReady = true;
}

export function onAppError(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
