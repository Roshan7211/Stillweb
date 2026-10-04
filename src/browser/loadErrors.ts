import { displayHost } from './url';

/** A page that failed to load, as the web view reports it (iOS NSURLError / WebKit codes, Android WebViewClient codes). */
export type LoadError = { url: string; code: number; description: string };

export type LoadErrorKind =
  | 'offline'
  | 'mobileDataOff'
  | 'notFound'
  | 'timeout'
  | 'cannotConnect'
  | 'notPrivate'
  | 'redirectLoop'
  | 'badAddress'
  | 'badResponse'
  | 'crashed'
  | 'unknown';

export type LoadErrorInfo = {
  kind: LoadErrorKind;
  icon: 'wifi-off' | 'smartphone' | 'search' | 'clock' | 'slash' | 'lock' | 'repeat' | 'link' | 'alert-triangle' | 'cpu';
  title: string;
  body: string;
  /** Offer to search for the site's name instead (it may not exist under that address). */
  canSearch: boolean;
  /** Offer the app's page in system Settings (mobile data switched off for the app). */
  canOpenSettings: boolean;
};

/** Stillweb's own code for a page whose renderer crashed or ran out of memory. */
export const PAGE_CRASHED = -10001;

const has = (description: string, ...needles: string[]) => needles.some((n) => description.includes(n));

/** Plain-language explanation and next steps for a failed page load. */
export function describeLoadError(e: LoadError): LoadErrorInfo {
  const host = displayHost(e.url) || 'this site';
  const d = e.description.toUpperCase();
  const c = e.code;
  const info = (kind: LoadErrorKind, icon: LoadErrorInfo['icon'], title: string, body: string, extra: Partial<LoadErrorInfo> = {}) => ({
    kind,
    icon,
    title,
    body,
    canSearch: false,
    canOpenSettings: false,
    ...extra,
  });

  if (c === PAGE_CRASHED || has(d, 'PAGE_CRASHED', 'PAGE_OUT_OF_MEMORY')) {
    return info('crashed', 'cpu', 'This page stopped working', `${host} crashed or used too much memory. Reloading usually fixes it.`);
  }
  if (c === -1009 || c === -1018 || c === -1019 || has(d, 'INTERNET_DISCONNECTED')) {
    return info('offline', 'wifi-off', 'You’re offline', 'Check your Wi-Fi or mobile data, then try again.');
  }
  if (c === -1020) {
    return info(
      'mobileDataOff',
      'smartphone',
      'Mobile data is off for Stillweb',
      'Connect to Wi-Fi, or turn on mobile data for Stillweb in Settings.',
      { canOpenSettings: true },
    );
  }
  if (c === -1003 || c === -1006 || c === -2 || has(d, 'NAME_NOT_RESOLVED', 'HOST_LOOKUP')) {
    return info('notFound', 'search', `Can’t find ${host}`, 'Check the address for typos, or search for the site instead.', {
      canSearch: true,
    });
  }
  if (c === -1001 || c === -8 || has(d, 'TIMED_OUT')) {
    return info('timeout', 'clock', `${host} is taking too long`, 'The site may be busy or down. Try again in a moment.');
  }
  if (c === -11 || (c <= -1200 && c >= -1206) || has(d, 'CERT', 'SSL', 'TLS', 'SECURE CONNECTION')) {
    return info(
      'notPrivate',
      'lock',
      'This connection isn’t private',
      `${host} has an invalid security certificate or connection, so the page was stopped to protect your information.`,
    );
  }
  if (c === -1007 || c === -9 || has(d, 'TOO_MANY_REDIRECTS', 'REDIRECT_LOOP')) {
    return info('redirectLoop', 'repeat', `${host} isn’t working`, 'It redirected too many times. Clearing this site’s data may help.');
  }
  if (c === -1000 || c === -1002 || c === -12 || c === -10 || c === 101 || has(d, 'UNSUPPORTED_SCHEME', 'BAD_URL', 'INVALID_URL')) {
    return info('badAddress', 'link', 'This address can’t be opened', 'It isn’t a valid web address. Check it and try again.');
  }
  if (c === -1011 || c === -1014 || c === -1015 || c === -1016 || c === -1017 || has(d, 'EMPTY_RESPONSE', 'INVALID_RESPONSE')) {
    return info('badResponse', 'alert-triangle', `${host} sent an invalid response`, 'The site may be having problems. Try again in a moment.');
  }
  if (
    c === -1004 ||
    c === -1005 ||
    c === -6 ||
    c === -7 ||
    c === -15 ||
    has(d, 'CONNECTION_REFUSED', 'CONNECTION_RESET', 'CONNECTION_CLOSED', 'ACCESS_DENIED', 'ADDRESS_UNREACHABLE')
  ) {
    return info('cannotConnect', 'slash', `Can’t connect to ${host}`, 'The site or your network refused the connection. It may be blocked on this network.');
  }
  return info('unknown', 'alert-triangle', `Can’t open ${host}`, 'The site couldn’t be reached. Try again in a moment.');
}
