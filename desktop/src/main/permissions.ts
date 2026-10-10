// What pages may do. Without these handlers Electron grants every request.
import { dialog, type Session } from 'electron';

import { BrowserWin } from './browserWindow';

/** Granted without asking: they are tied to something the user just did, or cannot do harm. */
const ALWAYS = new Set(['fullscreen', 'pointerLock', 'keyboardLock', 'clipboard-sanitized-write', 'automatic-fullscreen', 'speaker-selection', 'screen-wake-lock']);

/** Asked for, per site, the first time. Everything else is refused. */
const ASK: Record<string, string> = {
  geolocation: 'know your location',
  notifications: 'show notifications',
  'clipboard-read': 'read what you copied',
  midi: 'use your MIDI devices',
  midiSysex: 'use your MIDI devices',
};

function origin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

export function attachPermissions(session: Session): void {
  // Answers given so far, until the app quits: "origin|permission" -> allowed.
  const decided = new Map<string, boolean>();

  session.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
    if (ALWAYS.has(permission)) return true;
    return decided.get(`${requestingOrigin}|${permission}`) ?? false;
  });

  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (ALWAYS.has(permission)) return callback(true);
    const site = origin(details.requestingUrl || contents.getURL());
    let what = ASK[permission];
    if (permission === 'media') {
      const types = (details as { mediaTypes?: string[] }).mediaTypes ?? [];
      const camera = types.includes('video');
      const microphone = types.includes('audio');
      what = camera && microphone ? 'use your camera and microphone' : camera ? 'use your camera' : microphone ? 'use your microphone' : '';
    }
    if (!what || !site) return callback(false);

    const key = `${site}|${permission}`;
    const earlier = decided.get(key);
    if (earlier !== undefined) return callback(earlier);

    const found = BrowserWin.forTab(contents);
    const options = {
      type: 'question' as const,
      buttons: ['Allow', 'Block'],
      defaultId: 1,
      cancelId: 1,
      message: `${new URL(site).host} wants to ${what}`,
      detail: 'Your answer is remembered for this site until you quit Stillweb.',
    };
    const asked = found ? dialog.showMessageBox(found.win.window, options) : dialog.showMessageBox(options);
    void asked.then(({ response }) => {
      decided.set(key, response === 0);
      callback(response === 0);
    });
  });
}
