import * as LocalAuthentication from 'expo-local-authentication';

import { ShieldEngine } from '../../native/shield-webview';

let pending: Promise<LocalAuthentication.LocalAuthenticationResult> | null = null;

/**
 * The device's Face ID, fingerprint or passcode prompt. A second request while one is up gets
 * the same answer instead of a second prompt (a double tap on "Tap to unlock"). While it's up,
 * iOS's privacy blur stays off: the prompt makes the app inactive, which otherwise blurs it.
 */
export function authenticate(promptMessage: string): Promise<LocalAuthentication.LocalAuthenticationResult> {
  if (pending) return pending;
  ShieldEngine.setAuthenticating(true);
  pending = LocalAuthentication.authenticateAsync({ promptMessage }).finally(() => {
    pending = null;
    ShieldEngine.setAuthenticating(false);
  });
  return pending;
}
