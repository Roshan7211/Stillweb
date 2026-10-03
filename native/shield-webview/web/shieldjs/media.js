// Injected at document start into every frame (Android). Tells the app when audible media
// starts or stops, so it can show a playback notification and keep playing in the
// background, and carries commands back from that notification: play, pause, next,
// previous, seekforward, seekbackward and "seekto:<seconds>".
(function () {
  'use strict';
  var bridge = window.__shieldMedia;
  if (!bridge) return;
  try {
    delete window.__shieldMedia;
  } catch (e) {}

  // Remember the page's own Media Session handlers (e.g. next/previous track on music sites).
  var handlers = {};
  var sessionMetadata = null;
  if (!('mediaSession' in navigator)) {
    // Android WebView has no Media Session API. Provide a small one so music sites publish
    // track info, artwork and next/previous handlers, which the notification then uses.
    if (typeof window.MediaMetadata === 'undefined') {
      window.MediaMetadata = function MediaMetadata(init) {
        init = init || {};
        this.title = init.title || '';
        this.artist = init.artist || '';
        this.album = init.album || '';
        this.artwork = init.artwork || [];
      };
    }
    var session = {
      playbackState: 'none',
      setActionHandler: function (action, handler) {
        handlers[action] = handler;
        schedule();
      },
      setPositionState: function () {},
    };
    Object.defineProperty(session, 'metadata', {
      get: function () {
        return sessionMetadata;
      },
      set: function (value) {
        sessionMetadata = value;
        schedule();
      },
      enumerable: true,
    });
    try {
      Object.defineProperty(Navigator.prototype, 'mediaSession', {
        get: function () {
          return session;
        },
        configurable: true,
      });
    } catch (e) {}
  } else {
    try {
      var original = MediaSession.prototype.setActionHandler;
      MediaSession.prototype.setActionHandler = function (action, handler) {
        handlers[action] = handler;
        schedule();
        return original.apply(this, arguments);
      };
    } catch (e) {}
  }

  var lastPlayed = null;
  var lastKey = '';
  var forceReport = false;
  var MEDIA_EVENTS = ['play', 'playing', 'pause', 'ended', 'emptied', 'volumechange', 'loadedmetadata', 'durationchange', 'ratechange'];

  // Players created in code (new Audio(), radio and podcast sites) are never added to the
  // page, so neither querySelectorAll nor document-level listeners see them. Track every
  // element that is asked to play instead.
  var tracked = [];
  function track(el) {
    if (tracked.indexOf(el) !== -1) return;
    tracked.push(el);
    MEDIA_EVENTS.forEach(function (type) {
      el.addEventListener(type, schedule);
    });
    el.addEventListener('seeked', scheduleForced);
    if (tracked.length > 20) tracked.shift();
  }
  try {
    var originalPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      track(this);
      schedule();
      return originalPlay.apply(this, arguments);
    };
  } catch (e) {}

  function mediaElements() {
    var inPage = Array.prototype.slice.call(document.querySelectorAll('video, audio'));
    tracked.forEach(function (el) {
      if (inPage.indexOf(el) === -1) inPage.push(el);
    });
    return inPage;
  }

  function isLive(m) {
    return m !== null && (m.isConnected || tracked.indexOf(m) !== -1);
  }

  function isAudible(m) {
    return !m.paused && !m.ended && !m.muted && m.volume > 0;
  }

  function absolute(url) {
    try {
      return url ? new URL(url, location.href).href : '';
    } catch (e) {
      return '';
    }
  }

  /** Largest artwork the site published, else the video poster, else the page's share image. */
  function artwork(md, media) {
    var best = '';
    var bestSize = -1;
    ((md && md.artwork) || []).forEach(function (a) {
      var size = 0;
      String(a.sizes || '').split(/\s+/).forEach(function (s) {
        var w = parseInt(s, 10);
        if (w > size) size = w;
      });
      if (a.src && size > bestSize) {
        best = a.src;
        bestSize = size;
      }
    });
    if (!best && media && media.poster) best = media.poster;
    if (!best) {
      var og = document.querySelector('meta[property="og:image"], meta[name="twitter:image"]');
      if (og) best = og.getAttribute('content') || '';
    }
    if (!best) {
      // Last resort: the site's own icon (radio and podcast sites rarely publish artwork).
      var icon = document.querySelector('link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"]');
      if (icon) best = icon.getAttribute('href') || '';
    }
    return absolute(best);
  }

  function report() {
    var playing = false;
    mediaElements().forEach(function (m) {
      if (isAudible(m)) {
        playing = true;
        lastPlayed = m;
      }
    });
    var media = isLive(lastPlayed) ? lastPlayed : null;
    // Paused media that was playing keeps the session (so it can be resumed).
    var active = playing || (media !== null && !media.ended);
    var md = navigator.mediaSession && navigator.mediaSession.metadata;
    var duration = media && isFinite(media.duration) ? media.duration : 0;
    var info = {
      playing: playing,
      active: active,
      title: (md && md.title) || document.title || '',
      artist: (md && md.artist) || '',
      album: (md && md.album) || '',
      artwork: artwork(md, media),
      duration: duration,
      rate: media ? media.playbackRate || 1 : 1,
      canPrevious: !!handlers.previoustrack,
      canNext: !!handlers.nexttrack,
    };
    // Position changes constantly; the notification extrapolates it, so only report it when
    // something else changes or after a seek.
    var key = JSON.stringify(info);
    if (key === lastKey && !forceReport) return;
    lastKey = key;
    forceReport = false;
    info.position = media ? media.currentTime || 0 : 0;
    bridge.postMessage(JSON.stringify(info));
  }

  var timer = 0;
  function schedule() {
    if (!timer) {
      timer = setTimeout(function () {
        timer = 0;
        report();
      }, 150);
    }
  }

  function scheduleForced() {
    forceReport = true;
    schedule();
  }

  MEDIA_EVENTS.forEach(function (type) {
    document.addEventListener(type, schedule, true);
  });
  document.addEventListener('seeked', scheduleForced, true);
  // Titles change without media events on single-page apps.
  setInterval(function () {
    if (lastPlayed) report();
  }, 3000);

  function currentMedia() {
    return isLive(lastPlayed) ? lastPlayed : mediaElements()[0];
  }

  function seekBy(seconds) {
    var m = currentMedia();
    if (!m) return;
    var end = isFinite(m.duration) ? m.duration : Infinity;
    m.currentTime = Math.max(0, Math.min(end, (m.currentTime || 0) + seconds));
  }

  bridge.onmessage = function (event) {
    var command = String(event.data);
    var seekTo = /^seekto:([\d.]+)$/.exec(command);
    var action = seekTo
      ? 'seekto'
      : command === 'next'
        ? 'nexttrack'
        : command === 'previous'
          ? 'previoustrack'
          : command;
    var handler = handlers[action];
    if (handler) {
      try {
        handler(seekTo ? { action: action, seekTime: parseFloat(seekTo[1]) } : { action: action });
        scheduleForced();
        return;
      } catch (e) {}
    }
    var m = currentMedia();
    if (seekTo) {
      if (m) m.currentTime = parseFloat(seekTo[1]);
    } else if (command === 'seekforward') {
      seekBy(10);
    } else if (command === 'seekbackward') {
      seekBy(-10);
    } else if (command === 'pause') {
      mediaElements().forEach(function (el) {
        if (!el.paused) el.pause();
      });
    } else if (command === 'play' && m) {
      var p = m.play();
      if (p && p.catch) p.catch(function () {});
    }
    scheduleForced();
  };
})();
