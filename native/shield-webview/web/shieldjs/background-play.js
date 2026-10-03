// Injected at document start into every frame when background play is on. Sites pause
// audio/video when the page reports itself hidden (switching apps, screen off); keep the
// Page Visibility API reporting "visible" so playback continues like a music app.
(function () {
  'use strict';
  try {
    var proto = Document.prototype;
    Object.defineProperty(proto, 'hidden', { get: function () { return false; }, configurable: true });
    Object.defineProperty(proto, 'webkitHidden', { get: function () { return false; }, configurable: true });
    Object.defineProperty(proto, 'visibilityState', { get: function () { return 'visible'; }, configurable: true });
    Object.defineProperty(proto, 'webkitVisibilityState', { get: function () { return 'visible'; }, configurable: true });
  } catch (e) {}
  var swallow = function (e) {
    e.stopImmediatePropagation();
  };
  ['visibilitychange', 'webkitvisibilitychange'].forEach(function (type) {
    window.addEventListener(type, swallow, true);
    document.addEventListener(type, swallow, true);
  });

  // YouTube and YouTube Music pause long sessions with "Video paused. Continue watching?" /
  // "Still listening?" when they see no taps or keys (tracked in window._lact). While
  // listening in the background there are never any, so keep that timestamp fresh and, as a
  // fallback, confirm the dialog if it still appears.
  if (window === window.top && /(^|\.)youtube\.com$/.test(location.hostname)) {
    var setTimer = window.setInterval.bind(window);
    setTimer(function () {
      try {
        if (typeof window._lact === 'number') window._lact = Date.now();
      } catch (e) {}
      try {
        var dialog = document.querySelector(
          'ytmusic-you-there-renderer, yt-confirm-dialog-renderer, ytm-you-there-renderer, tp-yt-paper-dialog yt-confirm-dialog-renderer'
        );
        if (dialog && dialog.offsetParent !== null) {
          var button = dialog.querySelector('#confirm-button button, #confirm-button, yt-button-renderer button, button');
          if (button) button.click();
        }
      } catch (e) {}
    }, 30000);
  }
})();
