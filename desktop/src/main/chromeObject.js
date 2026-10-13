// Runs in every page before its own scripts. Chromium browsers give pages `chrome.loadTimes`,
// `chrome.csi` and `chrome.app`; they come from a part of Chromium that Electron leaves out.
// Sites use their absence to tell an embedded web view from a browser: Google's sign-in page
// answers "This browser or app may not be secure" without them. So pages get the same three,
// behaving as they do in a browser with nothing installed.
(function () {
  'use strict';
  try {
    if (!window.chrome) window.chrome = {};
    var chrome = window.chrome;
    var navigation = function () {
      var entries = performance.getEntriesByType('navigation');
      return entries.length ? entries[0] : null;
    };
    var seconds = function (ms) {
      return (performance.timeOrigin + ms) / 1000;
    };

    if (!chrome.loadTimes) {
      chrome.loadTimes = function loadTimes() {
        var nav = navigation();
        var paint = performance.getEntriesByType('paint')[0];
        var protocol = nav ? nav.nextHopProtocol || 'http/1.1' : 'http/1.1';
        var modern = /^h2|^h3/.test(protocol);
        return {
          requestTime: seconds(nav ? nav.startTime : 0),
          startLoadTime: seconds(nav ? nav.startTime : 0),
          commitLoadTime: seconds(nav ? nav.responseStart : 0),
          finishDocumentLoadTime: seconds(nav ? nav.domContentLoadedEventEnd : 0),
          finishLoadTime: seconds(nav ? nav.loadEventEnd : 0),
          firstPaintTime: seconds(paint ? paint.startTime : 0),
          firstPaintAfterLoadTime: 0,
          navigationType: nav && nav.type === 'reload' ? 'Reload' : nav && nav.type === 'back_forward' ? 'BackForward' : 'Other',
          wasFetchedViaSpdy: modern,
          wasNpnNegotiated: modern,
          npnNegotiatedProtocol: modern ? protocol : 'unknown',
          wasAlternateProtocolAvailable: false,
          connectionInfo: protocol,
        };
      };
    }
    if (!chrome.csi) {
      chrome.csi = function csi() {
        var nav = navigation();
        return {
          onloadT: Math.round(performance.timeOrigin + (nav ? nav.domContentLoadedEventEnd : 0)),
          startE: Math.round(performance.timeOrigin),
          pageT: performance.now(),
          tran: 15,
        };
      };
    }
    if (!chrome.app) {
      chrome.app = {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        getDetails: function getDetails() {
          return null;
        },
        getIsInstalled: function getIsInstalled() {
          return false;
        },
        installState: function installState(callback) {
          if (typeof callback === 'function') callback('not_installed');
        },
        runningState: function runningState() {
          return 'cannot_run';
        },
      };
    }
  } catch (e) {}
})();
