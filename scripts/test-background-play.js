#!/usr/bin/env node
// Tests the iOS background-play script (backgroundPlayScript in ios/ShieldWebView.swift)
// against a fake page that behaves like WebKit on iOS: events are queued, a video that starts
// playing pauses the other players of its page (the silent carrier included), and the
// "system" pauses media without the page asking (leaving the screen, a call, another app).
//   node scripts/test-background-play.js
// Device-only behavior (what iOS really suspends, the lock screen) still needs an iPhone.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/** The script as the page gets it: the Swift string literal, with its escapes undone. */
function scriptFromSwift() {
  const swift = fs.readFileSync(path.join(__dirname, '../native/shield-webview/ios/ShieldWebView.swift'), 'utf8');
  const at = swift.indexOf('private static let backgroundPlayScript = WKUserScript(');
  const start = swift.indexOf('source: """', at) + 'source: """\n'.length;
  const end = swift.indexOf('    """,', start);
  if (at < 0 || end < 0) throw new Error('backgroundPlayScript not found in ShieldWebView.swift');
  return swift.slice(start, end).replace(/\\\\/g, '\\');
}

function makeWorld(scriptSource, { hostname = 'music.example.com', quiet = false, storage = null } = {}) {
  let now = 1_000_000;
  let seq = 0;
  const timers = new Map();
  const setTimeoutFake = (fn, ms = 0) => {
    const id = ++seq;
    timers.set(id, { at: now + Math.max(0, ms), fn, id });
    return id;
  };
  const clearTimeoutFake = (id) => timers.delete(id);
  function advance(ms) {
    const end = now + ms;
    for (;;) {
      let next = null;
      for (const t of timers.values()) if (t.at <= end && (!next || t.at < next.at || (t.at === next.at && t.id < next.id))) next = t;
      if (!next) break;
      timers.delete(next.id);
      now = Math.max(now, next.at);
      next.fn();
    }
    now = end;
  }

  const docListeners = {};
  const winListeners = {};
  const media = [];

  class FakeMedia {
    constructor(kind, attached) {
      this.kind = kind; // 'video' (with sound) or 'audio'
      this.attached = attached;
      this.paused = true;
      this.ended = false;
      this.muted = false;
      this.isConnected = attached;
      this.duration = 200;
      this.currentTime = 0;
      this.playbackRate = 1;
      this.loop = false;
      this.own = {};
      this.playCalls = 0;
      this.blockPlay = false; // the system refuses (audio taken by a call)
      media.push(this);
    }
    addEventListener(type, fn) { (this.own[type] ||= []).push(fn); }
    fire(type) {
      setTimeoutFake(() => {
        const e = { type, target: this, isTrusted: false };
        (this.own[type] || []).forEach((fn) => fn(e));
        if (this.attached) (docListeners[type] || []).forEach((fn) => fn(e));
      }, 0);
    }
    play() {
      this.playCalls++;
      if (this.blockPlay) return Promise.reject(new Error('NotAllowedError'));
      if (this.paused) {
        this.paused = false;
        this.ended = false;
        this.fire('play');
        // A local file: it plays at once (videos say so when the test lets them).
        if (this.kind === 'audio') this.fire('playing');
      }
      // Admission: a video with sound that starts pauses the other players in the page.
      if (this.kind === 'video') {
        setTimeoutFake(() => {
          if (this.paused) return;
          for (const other of media) if (other !== this && !other.paused) other.systemPause();
        }, 1);
      }
      return Promise.resolve();
    }
    pause() {
      if (this.paused) return;
      this.paused = true;
      this.fire('pause');
    }
    // WebKit pausing it (background, eviction, interruption): no page code involved.
    systemPause() {
      if (this.paused) return;
      this.paused = true;
      this.fire('pause');
    }
    nowPlaying() { this.fire('playing'); }
    finish() { this.ended = true; this.paused = true; this.fire('pause'); this.fire('ended'); }
    tick(by = 1) { this.currentTime += by; this.fire('timeupdate'); }
    setMuted(muted) { this.muted = muted; this.fire('volumechange'); }
    // Taken out of the page: it stops, and the page's listeners never hear of it.
    remove() { this.attached = false; this.isConnected = false; this.paused = true; }
  }

  class MediaSession {
    constructor() { this.handlers = {}; this.state = 'none'; this.position = undefined; }
    setActionHandler(action, handler) { this.handlers[action] = handler; }
    setPositionState(state) { this.position = state; }
    get playbackState() { return this.state; }
    set playbackState(v) { this.state = v; }
  }
  const mediaSession = new MediaSession();

  function DocumentCtor() {}
  const document = {
    addEventListener(type, fn) { (docListeners[type] ||= []).push(fn); },
    querySelector() { return null; },
    querySelectorAll() { return media.filter((m) => m.attached); },
  };
  let carrier = null;
  const window = {
    addEventListener(type, fn) { (winListeners[type] ||= []).push(fn); },
    frames: [],
    requestAnimationFrame: (cb) => setTimeoutFake(() => cb(0), 16),
    cancelAnimationFrame: (id) => clearTimeoutFake(id),
    setInterval: () => 0,
    location: { hostname },
  };
  window.window = window;
  window.top = window;
  window.parent = window;
  if (quiet) window.__stillwebQuiet = true;
  const stored = storage || new Map();
  const sessionStorage = {
    getItem: (k) => (stored.has(k) ? stored.get(k) : null),
    setItem: (k, v) => stored.set(k, String(v)),
    removeItem: (k) => stored.delete(k),
  };
  const context = {
    window,
    document,
    Document: DocumentCtor,
    navigator: { mediaSession },
    MediaSession,
    Audio: function () {
      carrier = new FakeMedia('audio', false);
      return carrier;
    },
    URL: { createObjectURL: () => 'blob:silence' },
    Blob,
    ArrayBuffer,
    DataView,
    Date: { now: () => now },
    sessionStorage,
    setTimeout: setTimeoutFake,
    clearTimeout: clearTimeoutFake,
    performance: { now: () => now },
    location: window.location,
    isFinite,
    Math,
    Object,
    String,
    Number,
    Promise,
    console,
  };
  vm.createContext(context);
  vm.runInContext(scriptSource, context);

  return {
    advance,
    get carrier() { return carrier; },
    mediaSession,
    video: () => new FakeMedia('video', true),
    app: (state, fresh) => { window.__shieldAppState(state, fresh); advance(5); },
    userPause: () => { window.__stillwebUserPause(); advance(5); },
    gesture: (type = 'touchend') => { (winListeners[type] || []).forEach((fn) => fn({ type, isTrusted: true })); },
    // Everything is paused by the system at once (a call, another app's audio).
    interruption(block = true) {
      for (const m of media) { if (block) m.blockPlay = true; m.systemPause(); }
      advance(5);
    },
    endInterruption(resume) {
      for (const m of media) m.blockPlay = false;
      if (resume && carrier) { carrier.paused = false; carrier.fire('play'); carrier.fire('playing'); }
      advance(5);
    },
    stored,
  };
}

const source = scriptFromSwift();
let failed = 0;
function test(name, fn, options) {
  const w = makeWorld(source, options);
  const problems = [];
  const check = (label, cond) => { if (!cond) problems.push(label); };
  try {
    fn(w, check);
  } catch (e) {
    problems.push('threw: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e));
  }
  if (problems.length) failed++;
  console.log((problems.length ? 'FAIL  ' : 'ok    ') + name + (problems.length ? '\n        - ' + problems.join('\n        - ') : ''));
}
/** Starts a video on screen, as the user would. */
function startPlaying(w) {
  const v = w.video();
  w.gesture();
  v.play();
  w.advance(5);
  v.nowPlaying();
  w.advance(3000);
  return v;
}
/** The app leaves the screen: iOS pauses video with sound, in either order with the app's notice. */
function leave(w, v, { pauseFirst = false, lock = true } = {}) {
  w.app('inactive');
  w.advance(lock ? 30 : 600);
  if (pauseFirst) { v.systemPause(); w.advance(20); w.app('background'); }
  else { v.paused = true; w.app('background'); v.paused = false; v.systemPause(); w.advance(20); }
  w.advance(50);
}

test('leaving the screen: the video is played again and the carrier runs', (w, check) => {
  const v = startPlaying(w);
  leave(w, v);
  check('video playing', !v.paused);
  v.nowPlaying();
  w.advance(100);
  check('carrier exists and plays', w.carrier && !w.carrier.paused);
  check('video still playing', !v.paused);
});

test('the system pause lands before the app is told', (w, check) => {
  const v = startPlaying(w);
  leave(w, v, { pauseFirst: true });
  check('video playing', !v.paused);
  check('carrier plays', w.carrier && !w.carrier.paused);
});

test('the pause is on its way when the app is told (attribute set, event pending)', (w, check) => {
  const v = startPlaying(w);
  w.app('inactive');
  v.paused = true; // set by WebKit; its pause event comes a moment later
  w.app('background');
  check('asked to play again', !v.paused);
  v.fire('pause'); // the stale event
  w.advance(50);
  check('stale pause event ignored', !v.paused);
});

test('paused by the user, then the phone is locked right away: stays paused', (w, check) => {
  const v = startPlaying(w);
  w.gesture();
  v.pause();
  w.advance(400);
  w.app('inactive');
  w.advance(30);
  w.app('background');
  w.advance(6000);
  check('video stays paused', v.paused);
  check('no carrier running', !w.carrier || w.carrier.paused);
});

test('tap play, leave at once (before it has started playing)', (w, check) => {
  const v = w.video();
  w.gesture();
  v.play();
  w.advance(100);
  leave(w, v);
  check('video asked to play', !v.paused);
  v.nowPlaying();
  w.advance(100);
  check('not silenced', !v.paused);
  check('carrier plays', w.carrier && !w.carrier.paused);
});

test('next track in the same player: carrier bridges the gap and the loading time', (w, check) => {
  const v = startPlaying(w);
  leave(w, v);
  v.nowPlaying();
  w.advance(5000);
  v.finish();
  w.advance(50);
  check('carrier alone keeps the page awake', !w.carrier.paused);
  w.advance(3000);
  v.play(); // the page starts the next one; it now buffers for a long time
  w.advance(50);
  check('carrier restarted after the video paused it', !w.carrier.paused);
  w.advance(20000);
  check('carrier still playing while the video loads', !w.carrier.paused);
  v.nowPlaying();
  w.advance(100);
  check('both playing', !v.paused && !w.carrier.paused);
});

test('page pauses between videos and leaves the next one paused: started again', (w, check) => {
  const v = startPlaying(w);
  leave(w, v);
  v.nowPlaying();
  w.advance(5000);
  v.pause(); // the page, switching videos
  w.advance(50);
  check('carrier keeps running', !w.carrier.paused);
  w.advance(4100);
  check('nudged to play', !v.paused);
});

test('paused from the lock screen: stays paused, also when the app is opened again', (w, check) => {
  const v = startPlaying(w);
  w.mediaSession.constructor.prototype.setActionHandler.call(w.mediaSession, 'pause', () => v.pause());
  leave(w, v);
  v.nowPlaying();
  w.advance(5000);
  w.mediaSession.handlers.pause();
  w.advance(100);
  check('paused', v.paused);
  check('carrier stopped', w.carrier.paused);
  w.advance(20000);
  check('still paused after 20 s', v.paused);
  // Opening the app: WebKit plays what it paused on the way out.
  v.paused = false; v.fire('play');
  w.app('foreground');
  w.app('active');
  w.advance(100);
  check('WebKit\'s play was undone', v.paused);
  // The user's own tap still works.
  w.gesture();
  v.play();
  w.advance(50);
  v.nowPlaying();
  w.advance(50);
  check('user tap plays', !v.paused);
});

test('WebKit\'s play arrives after the app says it is back', (w, check) => {
  const v = startPlaying(w);
  w.mediaSession.constructor.prototype.setActionHandler.call(w.mediaSession, 'pause', () => v.pause());
  leave(w, v);
  v.nowPlaying();
  w.advance(5000);
  w.mediaSession.handlers.pause();
  w.advance(5000);
  w.app('foreground');
  v.paused = false; v.fire('play');
  w.advance(100);
  check('undone', v.paused);
});

test('paused from the lock screen, then played from the lock screen', (w, check) => {
  const v = startPlaying(w);
  const proto = w.mediaSession.constructor.prototype;
  proto.setActionHandler.call(w.mediaSession, 'pause', () => v.pause());
  proto.setActionHandler.call(w.mediaSession, 'play', () => v.play());
  leave(w, v);
  v.nowPlaying();
  w.advance(5000);
  w.mediaSession.handlers.pause();
  w.advance(30000);
  w.mediaSession.handlers.play();
  w.advance(50);
  v.nowPlaying();
  w.advance(100);
  check('playing', !v.paused);
  check('carrier plays', !w.carrier.paused);
});

test('no handlers in the page: the app\'s lock screen buttons control the video', (w, check) => {
  const v = startPlaying(w);
  leave(w, v);
  v.nowPlaying();
  w.advance(1000);
  check('pause handler installed', typeof w.mediaSession.handlers.pause === 'function');
  w.mediaSession.handlers.pause();
  w.advance(100);
  check('paused', v.paused && w.carrier.paused);
  w.mediaSession.handlers.play();
  w.advance(50);
  v.nowPlaying();
  w.advance(100);
  check('playing again', !v.paused && !w.carrier.paused);
  w.app('foreground');
  w.app('active');
  check('handlers removed on screen', !w.mediaSession.handlers.pause && !w.mediaSession.handlers.play);
});

test('a call (or another app) takes the audio: nothing is started again', (w, check) => {
  const v = startPlaying(w);
  leave(w, v);
  v.nowPlaying();
  w.advance(8000);
  const before = v.playCalls;
  const carrierBefore = w.carrier.playCalls;
  w.interruption();
  w.advance(30000);
  check('video not asked to play', v.playCalls === before);
  check('carrier not asked to play', w.carrier.playCalls === carrierBefore);
  // The call ends and the system gives the audio back.
  w.endInterruption(true);
  v.paused = false; v.fire('play'); v.nowPlaying();
  w.advance(200);
  check('playing again', !v.paused && !w.carrier.paused);
  // And the next gap is bridged as before.
  v.finish();
  w.advance(100);
  check('carrier bridges the next gap', !w.carrier.paused);
});

test('another app took the audio for good, then the app is opened: stays quiet', (w, check) => {
  const v = startPlaying(w);
  leave(w, v);
  v.nowPlaying();
  w.advance(8000);
  w.interruption(false);
  w.advance(60000);
  check('paused', v.paused);
  v.paused = false; v.fire('play'); // WebKit on the way back
  w.app('foreground');
  w.app('active');
  w.advance(100);
  check('undone', v.paused);
});

test('back on screen while listening: keeps playing, carrier stops', (w, check) => {
  const v = startPlaying(w);
  leave(w, v);
  v.nowPlaying();
  w.advance(8000);
  w.app('foreground');
  w.app('active');
  w.advance(3000);
  check('video playing', !v.paused);
  check('carrier stopped', w.carrier.paused);
  check('play state handed back', w.mediaSession.state === 'none');
  // And leaving again works the same.
  leave(w, v);
  check('video playing after second leave', !v.paused);
  v.nowPlaying();
  w.advance(100);
  check('carrier plays again', !w.carrier.paused);
});

test('a song is tapped and the phone locked before it starts: it plays', (w, check) => {
  const v = w.video();
  w.gesture(); // the tap; the page needs three seconds before it calls play()
  w.advance(500);
  w.app('inactive');
  w.app('background');
  w.advance(2500);
  v.play();
  w.advance(50);
  check('not silenced', !v.paused);
  v.nowPlaying();
  w.advance(100);
  check('carrier keeps it going', w.carrier && !w.carrier.paused);
});

test('nothing was playing and nothing starts: no carrier', (w, check) => {
  w.video();
  w.app('inactive');
  w.app('background');
  w.advance(5000);
  check('no carrier', !w.carrier || w.carrier.paused);
});

test('gap of more than a minute: the carrier rests', (w, check) => {
  const v = startPlaying(w);
  leave(w, v);
  v.nowPlaying();
  w.advance(5000);
  v.finish();
  w.advance(55000);
  check('carrier still on', !w.carrier.paused);
  w.advance(11000);
  check('carrier off', w.carrier.paused);
});

test('sleep timer / unplugged headphones: paused and not started again', (w, check) => {
  const v = startPlaying(w);
  leave(w, v);
  v.nowPlaying();
  w.advance(5000);
  w.userPause();
  w.advance(20000);
  check('paused', v.paused);
  check('carrier stopped', w.carrier.paused);
});

test('Control Center pause while the app is on screen, then lock: stays paused', (w, check) => {
  const v = startPlaying(w);
  w.app('inactive'); // Control Center opens
  w.advance(1000);
  check('app handler installed', typeof w.mediaSession.handlers.pause === 'function');
  w.mediaSession.handlers.pause();
  w.advance(1000);
  w.app('background');
  w.advance(6000);
  check('stays paused', v.paused);
});

test('Control Center opened and closed: nothing changes', (w, check) => {
  const v = startPlaying(w);
  w.app('inactive');
  w.advance(2000);
  w.app('active');
  w.advance(100);
  check('still playing', !v.paused);
  check('handlers removed', !w.mediaSession.handlers.pause);
});

test('a system pause that keeps coming back is not fought forever', (w, check) => {
  const v = startPlaying(w);
  leave(w, v);
  for (let i = 0; i < 30; i++) { v.nowPlaying(); w.advance(100); v.systemPause(); w.advance(100); }
  check('gave up eventually', v.playCalls < 20);
});

test('the video is shown to be playing: the carrier comes back after an unexplained pause', (w, check) => {
  const v = startPlaying(w);
  leave(w, v);
  v.nowPlaying();
  w.advance(8000);
  w.carrier.systemPause(); // paused without a video starting
  w.advance(100);
  check('carrier left alone at first', w.carrier.paused);
  v.tick();
  w.advance(100);
  check('carrier restarted once the video is heard', !w.carrier.paused);
});

test('restored page (quiet): nothing is tracked', (w, check) => {
  const v = w.video();
  v.paused = false; v.fire('play');
  w.advance(100);
  w.app('inactive');
  w.app('background');
  w.advance(100);
  check('no carrier', !w.carrier || w.carrier.paused);
}, { quiet: true });

test('a playlist page that loads in the background plays and keeps the page awake', (w, check) => {
  // The page before it, in the same tab, was being listened to.
  const before = makeWorld(source);
  const old = startPlaying(before);
  leave(before, old);
  old.nowPlaying();
  before.advance(100);
  const next = makeWorld(source, { storage: before.stored });
  next.app('background', true);
  check('carrier keeps the page awake while it loads', next.carrier && !next.carrier.paused);
  const v = next.video();
  next.advance(4000);
  v.play();
  next.advance(50);
  check('not silenced', !v.paused);
  next.advance(8000);
  check('carrier restarted after the video paused it', !next.carrier.paused);
  v.nowPlaying();
  next.advance(100);
  check('both playing', !v.paused && !next.carrier.paused);
});

test('a page that loads in the background after nothing was playing: no carrier, media may still start', (w, check) => {
  w.app('background', true);
  check('no carrier', !w.carrier || w.carrier.paused);
  const v = w.video();
  v.play();
  w.advance(50);
  check('not silenced', !v.paused);
  v.nowPlaying();
  w.advance(100);
  check('carrier once it plays', w.carrier && !w.carrier.paused);
});

test('listening is forgotten once the app is back on screen', (w, check) => {
  const v = startPlaying(w);
  leave(w, v);
  v.nowPlaying();
  w.advance(100);
  check('remembered while listening', w.stored.has('__stillwebListening'));
  w.app('foreground');
  check('forgotten', !w.stored.has('__stillwebListening'));
});

test('a restored (quiet) page that loads in the background stays silent', (w, check) => {
  w.app('background', true);
  check('no carrier', !w.carrier || w.carrier.paused);
}, { quiet: true });

test('a video that starts muted and is unmuted with a tap keeps playing after leaving', (w, check) => {
  const v = w.video();
  v.muted = true;
  v.play();
  w.advance(5);
  v.nowPlaying();
  w.advance(2000);
  w.gesture();
  v.setMuted(false);
  w.advance(3000);
  leave(w, v);
  check('played again', !v.paused);
  v.nowPlaying();
  w.advance(100);
  check('carrier plays', w.carrier && !w.carrier.paused);
});

test('muted, then paused, then leaving: stays paused', (w, check) => {
  const v = startPlaying(w);
  w.gesture();
  v.setMuted(true);
  w.advance(1000);
  w.gesture();
  v.pause();
  w.advance(1000);
  w.app('inactive');
  w.app('background');
  w.advance(6000);
  check('stays paused', v.paused);
  check('no carrier', !w.carrier || w.carrier.paused);
});

test('muted while playing, then leaving: not played again, nothing kept awake', (w, check) => {
  const v = startPlaying(w);
  w.gesture();
  v.setMuted(true);
  w.advance(1000);
  const calls = v.playCalls;
  w.app('inactive');
  w.advance(30);
  w.app('background');
  v.systemPause();
  w.advance(6000);
  check('not asked to play', v.playCalls === calls);
  check('no carrier', !w.carrier || w.carrier.paused);
});

test('the next track takes more than a minute to load: it still plays', (w, check) => {
  const v = startPlaying(w);
  leave(w, v);
  v.nowPlaying();
  w.advance(5000);
  v.finish();
  w.advance(66000);
  check('carrier rests', w.carrier.paused);
  v.play();
  w.advance(50);
  check('not silenced', !v.paused);
  v.nowPlaying();
  w.advance(100);
  check('playing with the carrier', !v.paused && !w.carrier.paused);
});

test('the app is only told it is in the background (no notice of leaving): what plays is found', (w, check) => {
  const v = startPlaying(w);
  w.app('background');
  v.systemPause();
  w.advance(50);
  check('played again', !v.paused);
  check('carrier plays', w.carrier && !w.carrier.paused);
});

test('a video taken out of the page while playing is not played again', (w, check) => {
  const v = startPlaying(w);
  v.remove();
  const calls = v.playCalls;
  w.app('inactive');
  w.app('background');
  w.advance(6000);
  check('not asked to play', v.playCalls === calls);
  check('no carrier', !w.carrier || w.carrier.paused);
});

test('a page that loaded in the background, paused from the lock screen: WebKit\'s play is undone', (w, check) => {
  w.app('background', true);
  const v = w.video();
  w.mediaSession.constructor.prototype.setActionHandler.call(w.mediaSession, 'pause', () => v.pause());
  v.play();
  w.advance(50);
  v.nowPlaying();
  w.advance(5000);
  w.mediaSession.handlers.pause();
  w.advance(5000);
  v.paused = false; v.fire('play'); // WebKit, just before the app says it is back
  w.advance(50);
  check('undone', v.paused);
});

test('the video finishes just as the app leaves: the page is kept awake for the next one', (w, check) => {
  const v = startPlaying(w);
  w.app('inactive');
  v.finish();
  w.advance(20);
  w.app('background');
  check('carrier bridges', w.carrier && !w.carrier.paused);
  v.play();
  w.advance(50);
  v.nowPlaying();
  w.advance(100);
  check('next one plays', !v.paused && !w.carrier.paused);
});

test('a player that starts on touch-down, right after the app is back', (w, check) => {
  const v = startPlaying(w);
  leave(w, v);
  v.nowPlaying();
  w.advance(3000);
  w.userPause(); // the sleep timer
  w.advance(5000);
  w.app('foreground');
  w.app('active');
  w.advance(300);
  w.gesture('touchstart');
  v.play();
  w.advance(50);
  check('the user\'s tap plays', !v.paused);
});

test('a page pause long after the carrier was paused is still bridged', (w, check) => {
  const v = startPlaying(w);
  leave(w, v);
  v.nowPlaying();
  w.advance(8000);
  w.carrier.systemPause(); // unexplained; the video keeps playing
  w.advance(100);
  v.tick();
  w.advance(100);
  w.carrier.systemPause(); // and again, before the next retry is due
  w.advance(1500);
  v.tick();
  w.advance(50);
  v.pause(); // the page switches videos
  w.advance(100);
  check('carrier bridges the gap', !w.carrier.paused);
  w.advance(4100);
  check('nudged', !v.paused);
});

test('a page told only that it loaded in the background, then that the app is active', (w, check) => {
  w.app('background', true);
  w.app('active');
  w.advance(3000);
  const v = w.video();
  v.play();
  w.advance(50);
  v.nowPlaying();
  w.advance(100);
  check('plays', !v.paused);
  check('no carrier on screen', !w.carrier || w.carrier.paused);
});

test('back in the app, a video is tapped at once and takes two seconds to start', (w, check) => {
  const v = startPlaying(w);
  leave(w, v);
  v.nowPlaying();
  w.advance(3000);
  w.userPause(); // the sleep timer
  w.advance(5000);
  w.app('foreground');
  w.app('active');
  w.advance(300);
  w.gesture();
  w.advance(1900);
  v.play();
  w.advance(50);
  v.nowPlaying();
  w.advance(50);
  check('plays', !v.paused);
});

test('paused in the page before leaving: the page may still start something on return', (w, check) => {
  const v = startPlaying(w);
  w.gesture();
  v.pause();
  w.advance(3000);
  w.app('inactive');
  w.app('background');
  w.advance(5000);
  w.app('foreground');
  w.app('active');
  w.advance(200);
  v.play(); // the page's own doing (WebKit doesn't start what was paused before leaving)
  w.advance(50);
  check('not silenced', !v.paused);
});

test('the video stalls (no network): the carrier rests after a minute', (w, check) => {
  const v = startPlaying(w);
  leave(w, v);
  v.nowPlaying();
  for (let i = 0; i < 20; i++) { w.advance(1000); v.tick(); }
  w.advance(100);
  check('carrier on while it plays', !w.carrier.paused);
  // From here on it makes no progress, and never says so.
  w.advance(55000);
  check('carrier still on for a minute', !w.carrier.paused);
  w.advance(11000);
  check('carrier rests', w.carrier.paused);
  // And when it plays on after all, everything is back.
  v.nowPlaying();
  w.advance(100);
  check('carrier back with the video', !w.carrier.paused);
});

test('a long video keeps the carrier for as long as it plays', (w, check) => {
  const v = startPlaying(w);
  leave(w, v);
  v.nowPlaying();
  for (let i = 0; i < 300; i++) { w.advance(1000); v.tick(); }
  check('carrier on after five minutes', !w.carrier.paused);
  check('video playing', !v.paused);
});

test('a page that keeps pausing what was started again is left alone after three tries', (w, check) => {
  const v = startPlaying(w);
  leave(w, v);
  v.nowPlaying();
  w.advance(5000);
  const before = v.playCalls;
  v.pause();
  for (let i = 0; i < 40; i++) {
    w.advance(500);
    if (!v.paused) { w.advance(2500); v.pause(); } // the page wants it paused
  }
  w.advance(20000);
  check('at most three tries', v.playCalls - before <= 3);
  check('paused in the end', v.paused);
  w.advance(60000);
  check('and the carrier rests', w.carrier.paused);
});

test('tries start over once the media has played on', (w, check) => {
  const v = startPlaying(w);
  leave(w, v);
  v.nowPlaying();
  w.advance(5000);
  for (let round = 0; round < 5; round++) {
    v.pause(); // between two videos
    w.advance(4100);
    check('started again in round ' + round, !v.paused);
    v.nowPlaying();
    for (let i = 0; i < 10; i++) { w.advance(1000); v.tick(); }
  }
});

test('media the script never saw start is still played again when the system pauses it', (w, check) => {
  const v = w.video();
  v.muted = true;
  v.play();
  w.advance(5);
  v.nowPlaying();
  w.advance(2000);
  v.muted = false; // unmuted without the page saying so
  w.advance(2000);
  v.paused = true; // the system's pause, on its way
  w.app('background');
  v.fire('pause');
  w.advance(50);
  check('played again', !v.paused);
  check('carrier plays', w.carrier && !w.carrier.paused);
});

test('Control Center while the app is on screen: a handler the page removes is replaced', (w, check) => {
  const v = startPlaying(w);
  const proto = w.mediaSession.constructor.prototype;
  w.app('inactive');
  proto.setActionHandler.call(w.mediaSession, 'pause', null);
  check('the app\'s pause is in place', typeof w.mediaSession.handlers.pause === 'function');
  w.mediaSession.handlers.pause();
  w.advance(50);
  check('paused', v.paused);
});

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
