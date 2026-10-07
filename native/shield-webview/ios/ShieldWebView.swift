import AVFoundation
import ExpoModulesCore
import UIKit
import WebKit

/// Forwards script messages without WKUserContentController retaining the view.
private final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
  weak var target: WKScriptMessageHandler?
  init(_ target: WKScriptMessageHandler) { self.target = target }
  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    target?.userContentController(controller, didReceive: message)
  }
}

/// A tab's content controller. Windows a page opens (sign-in pop-ups) share their opener's
/// controller, so what has been installed in it is tracked here rather than per view.
final class ShieldContentController: WKUserContentController {
  var appliedHost: String?
  var appliedGeneration = -1
  var rulesAttached = false
  /// The page was loaded again without the user asking (restored tab, ended process): media
  /// stays silent until the user touches the page.
  var quiet = false
  var appliedQuiet = false
}

/// The view controller to present system UI (dialogs, share sheets, previews) from.
func topViewController(for view: UIView?) -> UIViewController? {
  let window = view?.window
    ?? UIApplication.shared.connectedScenes
    .compactMap { ($0 as? UIWindowScene)?.windows.first(where: \.isKeyWindow) }
    .first
  var top = window?.rootViewController
  while let presented = top?.presentedViewController, !presented.isBeingDismissed {
    top = presented
  }
  return top
}

/// Listen Mode's sleep timer (Stillweb Plus). A native timer keeps running while the app plays
/// audio in the background; when it fires, media in every tab is paused.
final class SleepTimer {
  static let shared = SleepTimer()
  private var timer: Timer?
  private let views = NSHashTable<ShieldWebView>.weakObjects()
  var onFired: (() -> Void)?

  func register(_ view: ShieldWebView) { views.add(view) }

  /// Pauses everything after `seconds`; nil or 0 cancels.
  func set(seconds: Double?) {
    timer?.invalidate()
    timer = nil
    guard let seconds, seconds > 0 else { return }
    let t = Timer(timeInterval: seconds, repeats: false) { [weak self] _ in self?.fire() }
    RunLoop.main.add(t, forMode: .common)
    timer = t
  }

  private func fire() {
    timer = nil
    views.allObjects.forEach { $0.pauseAllMedia() }
    onFired?()
  }

  /// Every tab's web view (the timer's registry doubles as the list of live pages).
  var allViews: [ShieldWebView] { views.allObjects }
}

/// Unplugged headphones (or AirPods taken out): iOS pauses the media, and pages are told it
/// was the user's pause, so background play never starts it again on the speaker.
final class HeadphoneWatcher {
  static let shared = HeadphoneWatcher()
  private var observer: NSObjectProtocol?

  func start() {
    guard observer == nil else { return }
    observer = NotificationCenter.default.addObserver(
      forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
    ) { note in
      let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
      guard raw.flatMap(AVAudioSession.RouteChangeReason.init(rawValue:)) == .oldDeviceUnavailable else { return }
      SleepTimer.shared.allViews.forEach { $0.markUserPause() }
    }
  }
}

/// WKWebView with EasyList/EasyPrivacy-derived WKContentRuleLists attached and per-host
/// scriptlets injected at document start.
final class ShieldWebView: ExpoView, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKDownloadDelegate,
  UIScrollViewDelegate
{
  let onLoadStart = EventDispatcher()
  let onLoadEnd = EventDispatcher()
  let onLoadProgress = EventDispatcher()
  let onNavigationStateChange = EventDispatcher()
  let onBlockedCountChange = EventDispatcher()
  let onOpenWindow = EventDispatcher()
  let onPopupBlocked = EventDispatcher()
  let onDownloadRequest = EventDispatcher()
  let onLoadError = EventDispatcher()
  let onExternalLink = EventDispatcher()
  // Android only: WKWebView shows its own link menu (see onLinkAction) and file picker.
  let onContextMenu = EventDispatcher()
  let onFileChooser = EventDispatcher()
  let onFullscreenChange = EventDispatcher()
  let onFindResult = EventDispatcher()
  let onCloseRequest = EventDispatcher()
  /// iOS: a choice from the link long-press menu that the app carries out (new tabs).
  let onLinkAction = EventDispatcher()
  /// iOS: scrolling down asks the browser bars to shrink, scrolling up to come back.
  let onChromeChange = EventDispatcher()
  /// iOS: the page started or stopped playing media with sound (a playing tab is kept alive).
  let onMediaStateChange = EventDispatcher()

  var initialUrl: String?
  var incognito = false
  /// Stillweb Plus profile (nil = the default one); fixed when the web view is created.
  var profileId: String?
  var forceDark = false
  var textZoom = 100
  /// The tab on screen: only it may show page dialogs or scroll to top from the status bar.
  var active = true
  /// Edge to edge, like Safari: the page fills the screen and scrolls under the status bar and
  /// the app's bottom bar. These are what the app's bars cover beyond the safe area; WebKit
  /// keeps the page's fixed headers and footers clear of all of it. nil: the app lays the page
  /// out between its bars.
  var chromeInsets: UIEdgeInsets?
  /// Adopts the web view created for a page's window.open instead of making a new one.
  var popupId: String?
  /// The tab's page is being loaded again from its saved address (after a restart, or after
  /// its web view was released): it doesn't start playing by itself.
  var restored = false

  private var webView: WKWebView?
  /// Last load progress sent to the app.
  private var sentProgress = 0.0
  private var observations: [NSKeyValueObservation] = []
  private var appObservers: [NSObjectProtocol] = []
  private var shieldsActive = true
  private var countedHost: String?
  private var blockedOnPage = 0
  /// Blocked request counts by host since the last event (for the privacy report).
  private var blockedHosts: [String: Int] = [:]
  private var pendingUpgradeURL: URL?
  private var downloadProgress: [ObjectIdentifier: NSKeyValueObservation] = [:]
  private var downloadPaths: [ObjectIdentifier: String] = [:]
  private static var httpOnlyHosts = Set<String>()

  /// Web views WebKit asked for when a page opened a window, kept until the app shows them
  /// in a new tab. Returning a real web view keeps `window.opener`, which sign-in and
  /// payment pop-ups need to report back to the page that opened them.
  private static var pendingPopups: [String: WKWebView] = [:]

  /// Counts resource loads that fail (content-blocked requests surface as load errors), with
  /// their hosts for the privacy report. WebKit doesn't report blocked requests, so the iOS
  /// counter is an estimate.
  private static let statsScript = WKUserScript(
    source: """
    (function () {
      var pending = 0, hosts = {}, timer = 0;
      var tags = /^(SCRIPT|IMG|IFRAME|LINK|VIDEO|AUDIO|SOURCE|EMBED|OBJECT)$/;
      function flush() {
        timer = 0;
        if (pending) {
          window.webkit.messageHandlers.shieldStats.postMessage({ count: pending, hosts: hosts });
          pending = 0;
          hosts = {};
        }
      }
      window.addEventListener('error', function (e) {
        var el = e.target;
        if (el && el !== window && el.tagName && tags.test(el.tagName)) {
          pending++;
          var match = /^https?:\\/\\/([^\\/?#:]+)/i.exec(el.currentSrc || el.src || el.href || '');
          if (match) {
            var host = match[1].toLowerCase();
            hosts[host] = (hosts[host] || 0) + 1;
          }
          if (!timer) timer = setTimeout(flush, 300);
        }
      }, true);
    })();
    """,
    injectionTime: .atDocumentStart,
    forMainFrameOnly: false,
    in: .defaultClient
  )

  /// The image under the finger, for the long-press menu (WebKit only tells it about links).
  /// One touch at a time across the app, so this is shared by all views.
  private static var touchedImage: URL?

  private static let touchScript = WKUserScript(
    source: """
    (function () {
      document.addEventListener('touchstart', function (e) {
        if (e.touches.length !== 1) return;
        var img = e.target && e.target.closest ? e.target.closest('img') : null;
        var src = img ? (img.currentSrc || img.src || '') : '';
        try { window.webkit.messageHandlers.shieldTouch.postMessage(src); } catch (err) {}
      }, { capture: true, passive: true });
    })();
    """,
    injectionTime: .atDocumentStart,
    forMainFrameOnly: false,
    in: .defaultClient
  )

  /// Reports whether a frame has media with sound playing, so the app never releases the web
  /// view of a tab that is being listened to. "Playing" is told at once; "silent" only after
  /// a minute and a half without sound, because a pause is often short: the system's when
  /// the app leaves the screen, or the gap between two videos.
  private static let mediaStateScript = WKUserScript(
    source: """
    (function () {
      var id = Math.random().toString(36).slice(2);
      var playing = new Set();
      var told = false;
      var checkTimer = 0;
      var silentTimer = 0;
      function audible(m) {
        return !m.paused && !m.ended && !m.muted && m.isConnected;
      }
      function post(value) {
        told = value;
        try { window.webkit.messageHandlers.shieldMedia.postMessage({ id: id, playing: value }); } catch (err) {}
      }
      function update(atOnce) {
        // Media removed from the page stops without saying so.
        playing.forEach(function (m) { if (!audible(m)) playing.delete(m); });
        if (playing.size > 0) {
          clearTimeout(silentTimer);
          silentTimer = 0;
          if (!checkTimer) checkTimer = setInterval(update, 5000);
          if (!told) post(true);
          return;
        }
        clearInterval(checkTimer);
        checkTimer = 0;
        if (!told) return;
        if (atOnce === true) {
          clearTimeout(silentTimer);
          silentTimer = 0;
          return post(false);
        }
        if (!silentTimer) {
          silentTimer = setTimeout(function () {
            silentTimer = 0;
            if (!playing.size && told) post(false);
          }, 90000);
        }
      }
      ['playing', 'pause', 'ended', 'emptied', 'volumechange'].forEach(function (type) {
        document.addEventListener(type, function (e) {
          var m = e.target;
          if (!m || typeof m.pause !== 'function') return;
          if (audible(m)) playing.add(m);
          update();
        }, true);
      });
      window.addEventListener('pagehide', function () {
        playing.clear();
        update(true);
      });
    })();
    """,
    injectionTime: .atDocumentStart,
    forMainFrameOnly: false,
    in: .defaultClient
  )

  /// Calm Mode's cookie pop-up script is large (it takes 10-25 ms to compile), so it runs in
  /// the main frame only. Frames ask for it here when they look like a consent dialog: a
  /// consent platform's address, or a site whose consent rules run in its frames (the
  /// frame rules of scripts/gen-autoconsent.mjs's autoconsent build).
  private static let consentFrameScript = WKUserScript(
    source: """
    (function () {
      if (window === window.top) return;
      var url = location.href;
      if (!/^https?:/.test(url)) return;
      if (/consent|cookie|gdpr|privacy|cmp|message_id|sp-prod|trustarc|tinypass|piano\\.io|clym-sdk/i.test(url) ||
          /(^|\\.)(dropbox|tumblr|coinbase|gmx|thisismoney|interpolis|swisscare|coasthotels|village-hotels|natureconservancy|combell|huss-licht-ton|modellbau-berlinski)\\.[a-z.]+$|(^|\\.)(web\\.de|gmx\\.net|webarchive\\.nationalarchives\\.gov\\.uk)$/i.test(location.hostname)) {
        try { window.webkit.messageHandlers.shieldConsentFrame.postMessage(1); } catch (e) {}
      }
    })();
    """,
    injectionTime: .atDocumentStart,
    forMainFrameOnly: false,
    in: .defaultClient
  )

  /// Videos play inline, like in Safari, unless the user asks for fullscreen. iPhone WebKit
  /// opens a video without `playsinline` in fullscreen as soon as it plays; pages reloaded
  /// with pull to refresh start playing before the site adds it.
  private static let inlineVideoScript = WKUserScript(
    source: """
    (function () {
      function inline(v) {
        if (!v.hasAttribute('playsinline')) v.setAttribute('playsinline', '');
        if (!v.hasAttribute('webkit-playsinline')) v.setAttribute('webkit-playsinline', '');
      }
      try {
        var play = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function () {
          if (this instanceof HTMLVideoElement) inline(this);
          return play.apply(this, arguments);
        };
      } catch (e) {}
      // Videos that start on their own (autoplay) get it as soon as they are added.
      try {
        new MutationObserver(function (records) {
          for (var i = 0; i < records.length; i++) {
            var added = records[i].addedNodes;
            for (var j = 0; j < added.length; j++) {
              var node = added[j];
              if (node.nodeType !== 1) continue;
              if (node.tagName === 'VIDEO') inline(node);
              else if (node.firstElementChild) {
                var videos = node.getElementsByTagName('video');
                for (var k = 0; k < videos.length; k++) inline(videos[k]);
              }
            }
          }
        }).observe(document, { childList: true, subtree: true });
      } catch (e) {}
    })();
    """,
    injectionTime: .atDocumentStart,
    forMainFrameOnly: false,
    in: .page
  )

  /// Global Privacy Control signal for every frame (see web/shieldjs/privacy.js).
  private static let privacyScript = WKUserScript(
    source: """
    (function () {
      try {
        Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', {
          get: function () { return true; }, configurable: true, enumerable: true
        });
      } catch (e) {}
    })();
    """,
    injectionTime: .atDocumentStart,
    forMainFrameOnly: false,
    in: .page
  )

  /// For pages the app loaded again by itself (a restored tab, a page whose process iOS ended,
  /// a reload for the theme): media with sound doesn't start until the user touches the page,
  /// as in Safari. Otherwise a song starts over, or starts at all, just because the app was
  /// opened. Muted video may still play.
  private static let quietScript = WKUserScript(
    source: """
    (function () {
      var quiet = true;
      try {
        Object.defineProperty(window, '__stillwebQuiet', { get: function () { return quiet; }, configurable: true });
      } catch (e) {}
      function lift() {
        if (!quiet) return;
        quiet = false;
        for (var i = 0; i < window.frames.length; i++) {
          try { window.frames[i].postMessage({ __stillwebAllowPlay: true }, '*'); } catch (e) {}
        }
      }
      ['touchstart', 'pointerdown', 'touchend', 'mousedown', 'keydown', 'click'].forEach(function (type) {
        window.addEventListener(type, function (e) { if (e.isTrusted) lift(); }, true);
      });
      window.addEventListener('message', function (e) {
        if (e.source === window.parent && window.parent !== window && e.data && e.data.__stillwebAllowPlay === true) lift();
      });
      try {
        var play = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function () {
          if (quiet && !this.muted) {
            return Promise.reject(new DOMException('Playback waits for the user after the page was restored.', 'NotAllowedError'));
          }
          return play.apply(this, arguments);
        };
      } catch (e) {}
      // Media that starts without play() (the autoplay attribute), or is unmuted while playing.
      function hush(e) {
        var m = e.target;
        if (quiet && m && typeof m.pause === 'function' && !m.muted && !m.paused) {
          try { m.pause(); } catch (err) {}
        }
      }
      document.addEventListener('play', hush, true);
      document.addEventListener('volumechange', hush, true);
    })();
    """,
    injectionTime: .atDocumentStart,
    forMainFrameOnly: false,
    in: .page
  )

  /// Tells the app about the first touch on a quiet page, so the pages after it aren't quiet.
  private static let quietTouchScript = WKUserScript(
    source: """
    (function () {
      var told = false;
      ['touchstart', 'pointerdown', 'touchend', 'mousedown', 'keydown'].forEach(function (type) {
        window.addEventListener(type, function (e) {
          if (told || !e.isTrusted) return;
          told = true;
          try { window.webkit.messageHandlers.shieldGesture.postMessage(1); } catch (err) {}
        }, true);
      });
    })();
    """,
    injectionTime: .atDocumentStart,
    forMainFrameOnly: false,
    in: .defaultClient
  )

  /// Keeps pages reporting "visible" so audio continues in the background (web/shieldjs/background-play.js).
  /// iOS also pauses video with sound when the app leaves the screen and suspends a page once
  /// nothing plays; with `__shieldAppState`, called by the app (and passed on to frames), the
  /// script plays again what the system paused, keeps animation-frame callbacks running and
  /// bridges the gap to the next video of a playlist with silence. What the user paused, or a
  /// call or another app silenced, is left alone.
  private static let backgroundPlayScript = WKUserScript(
    source: """
    (function () {
      try {
        var p = Document.prototype;
        Object.defineProperty(p, 'hidden', { get: function () { return false; }, configurable: true });
        Object.defineProperty(p, 'webkitHidden', { get: function () { return false; }, configurable: true });
        Object.defineProperty(p, 'visibilityState', { get: function () { return 'visible'; }, configurable: true });
        Object.defineProperty(p, 'webkitVisibilityState', { get: function () { return 'visible'; }, configurable: true });
      } catch (e) {}
      var swallow = function (e) { e.stopImmediatePropagation(); };
      ['visibilitychange', 'webkitvisibilitychange'].forEach(function (t) {
        window.addEventListener(t, swallow, true);
        document.addEventListener(t, swallow, true);
      });

      // What WebKit does on iOS, and what this script does about it. The app calls
      // __shieldAppState with 'inactive' when it starts to leave the screen (also for Control
      // Center and the like), 'background' once it has left, 'foreground' on its way back and
      // 'active' when it is in use again. A page that loads while the app is in the background
      // (the next video of a playlist, on sites that open it as a new page) is told so with
      // `fresh`: if the page before it was being listened to, so is this one.
      // - Leaving the screen (or locking it) pauses video with sound. While the user is
      //   listening, it is played again.
      // - Once nothing in the page is audible, iOS suspends the app within seconds, so the next
      //   video of a playlist never starts. A silent audio player (the carrier) keeps the page
      //   running for as long as the user is listening. It also carries the lock screen, which a
      //   hidden page's video may not: with the page's own title and artwork, and the real
      //   media's position and play state.
      // - A video that starts playing pauses the other players in its page, the carrier
      //   included: it is started again right away, so it also covers the time the video takes
      //   to load.
      // - A call, another app's audio or unplugged headphones pause everything. Nothing is
      //   started again then, until the system (or the user) does.
      // - Back on screen WebKit plays what it paused on the way out, also when the user has
      //   paused it from the lock screen since: that play is undone.
      // - The carrier only runs while real media is heard to make progress, or is expected to
      //   start within a minute. A video that stalls, or a page that keeps pausing what was
      //   started again, lets the page (and the app) rest.
      // - Sites start the next video of a playlist muted when no tap led to it ("tap to
      //   unmute"). In the background nobody can tap: what is being listened to keeps its sound.
      var background = false;
      var listening = false; // in the background: the user wants to hear this page
      var interrupted = false; // the system took the audio away
      var current = null; // the media being listened to
      var started = null; // media that was asked to play and hasn't paused since
      var lastPause = null; // the latest pause on screen
      var resignAt = 0; // when the app started to leave the screen
      var atResign = null; // and what was playing then
      var resumeUntil = 0;
      var userPausedAt = 0;
      var userActionAt = 0; // lock screen / Control Center buttons
      var gestureAt = 0; // taps and keys in the page
      var playAt = 0; // the latest start of any media
      var keepPausedUntil = 0;
      var userPaused = false; // paused from the lock screen, the sleep timer or by unplugging: stays paused
      var leftAt = 0; // when the app left the screen
      var heardAt = 0; // when media was last heard to play, or last expected to start
      var silenced = null;
      var fights = 0; // times media was started again without it getting anywhere since
      var nudges = 0;
      var fightFrom = -1;
      var unmutes = 0; // times the media being listened to got its sound back (per video)
      var unmutedAt = 0;
      var siteUnmute = function () { return false; }; // a site's own way to unmute its player
      // Listening is remembered for the tab's next page (see `fresh`), for a minute and a half.
      var MARK = '__stillwebListening';
      var markedAt = 0;
      function mark(on) {
        markedAt = on ? Date.now() : 0;
        try {
          if (on) sessionStorage.setItem(MARK, String(markedAt));
          else sessionStorage.removeItem(MARK);
        } catch (e) {}
      }
      function marked() {
        try {
          var t = Number(sessionStorage.getItem(MARK));
          return t > 0 && Date.now() - t < 90000;
        } catch (e) {
          return false;
        }
      }
      function quiet() {
        try { return window.__stillwebQuiet === true; } catch (e) { return false; }
      }
      function resume(m) {
        try { var r = m.play(); if (r && r.catch) r.catch(function () {}); } catch (e) {}
      }
      // Pauses that keep coming back (from the system or the page) aren't fought forever: the
      // count starts over once the media has played on for a few seconds.
      function resumeAgain(m) {
        if (fights >= 8) return;
        fights++;
        fightFrom = m.currentTime;
        resume(m);
      }
      ['touchstart', 'pointerdown', 'touchend', 'click', 'keydown'].forEach(function (type) {
        window.addEventListener(type, function (e) {
          if (!e.isTrusted) return;
          gestureAt = Date.now();
          // The user is back at the page: what starts now is theirs, however long it loads.
          keepPausedUntil = 0;
          userPaused = false;
        }, true);
      });

      var carrier = null;
      var carrierOn = false; // it should be playing
      var carrierPlayed = false; // and it has been, since it was last started
      var carrierPausedAt = 0; // when something else paused it (0 while it plays)
      var carrierStarts = [];
      var watchTimer = 0;
      var nudgeTimer = 0;
      function silentWav() {
        var rate = 8000, n = rate * 2, buf = new ArrayBuffer(44 + n), v = new DataView(buf);
        var text = function (at, str) { for (var i = 0; i < str.length; i++) v.setUint8(at + i, str.charCodeAt(i)); };
        text(0, 'RIFF'); v.setUint32(4, 36 + n, true); text(8, 'WAVE'); text(12, 'fmt ');
        v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
        v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
        text(36, 'data'); v.setUint32(40, n, true);
        for (var i = 0; i < n; i++) v.setUint8(44 + i, 128);
        return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
      }
      function startCarrier() {
        if (!carrierOn) watch();
        try {
          if (!carrier) {
            carrier = new Audio(silentWav());
            carrier.loop = true;
            carrier.addEventListener('playing', carrierPlaying);
            carrier.addEventListener('pause', carrierPaused);
          }
          carrierOn = true;
          if (carrier.paused) resume(carrier);
        } catch (e) {}
      }
      function stopCarrier() {
        clearTimeout(watchTimer);
        clearTimeout(nudgeTimer);
        carrierOn = false;
        carrierPlayed = false;
        carrierPausedAt = 0;
        try { if (carrier && !carrier.paused) carrier.pause(); } catch (e) {}
      }
      function carrierPlaying() {
        if (!carrierOn) {
          // Started by the system (after a call) when it isn't wanted any more.
          try { carrier.pause(); } catch (e) {}
          return;
        }
        carrierPlayed = true;
        carrierPausedAt = 0;
        if (!interrupted) return;
        // The system gave the audio back (the call ended).
        interrupted = false;
        heardAt = Date.now();
        if (background && listening && current && current.paused && !current.ended) nudge(current, heardAt);
      }
      function carrierPaused() {
        if (!carrierOn || !carrier || !carrier.paused) return;
        var now = Date.now();
        carrierPausedAt = now;
        if (now - playAt < 2000) {
          // A video that started playing paused it.
          carrierStarts = carrierStarts.filter(function (t) { return now - t < 10000; });
          if (carrierStarts.length < 6) {
            carrierStarts.push(now);
            resume(carrier);
          }
          return;
        }
        if (carrierPlayed) systemTookAudio();
      }
      function systemTookAudio() {
        interrupted = true;
        clearTimeout(nudgeTimer);
        syncLockScreen();
      }
      // Nothing heard for a minute (the playlist is over, the video stalled, the page keeps it
      // paused): the page may rest. What it starts later still plays.
      function watch() {
        clearTimeout(watchTimer);
        watchTimer = setTimeout(function () {
          if (!carrierOn) return;
          if (!interrupted && Date.now() - heardAt > 60000) {
            listening = false;
            mark(false);
            return stopCarrier();
          }
          watch();
        }, 5000);
      }
      // Media the page left paused in the background (not by the user) is started again a few
      // seconds later, up to three times in a row.
      function nudge(m, pausedAt) {
        clearTimeout(nudgeTimer);
        if (nudges >= 3) return;
        nudgeTimer = setTimeout(function () {
          if (!background || !listening || interrupted) return;
          if (!m.paused || m.ended || !m.isConnected || userPausedAt > pausedAt) return;
          nudges++;
          fightFrom = m.currentTime;
          resumeUntil = Date.now() + 2000;
          resume(m);
          nudge(m, pausedAt);
        }, 4000);
      }

      // Lock screen and Control Center buttons. The page's own handlers are used as they are;
      // for the basic buttons it doesn't handle, the app's act on the media being listened to
      // (otherwise they would control the carrier). Each press is the user's: a pause is never
      // undone, and a play makes the page worth keeping awake again.
      var mediaSession = navigator.mediaSession;
      var setActionHandler = null;
      var setPositionState = null;
      var setPlaybackState = null;
      var pageHandlers = {};
      var pageSetsPosition = false;
      var pageSetsState = false;
      var ownPosition = false;
      var ownState = false;
      function userAction(action, handler) {
        return function () {
          var now = Date.now();
          userActionAt = now;
          keepPausedUntil = 0;
          if (action === 'pause' || action === 'stop') {
            userPausedAt = now;
            userPaused = true;
            listening = false;
            mark(false);
            stopCarrier();
          } else if (action === 'play' || action === 'nexttrack' || action === 'previoustrack') {
            userPaused = false;
            fights = 0;
            nudges = 0;
            if (background) {
              // The page is kept awake for what the press starts.
              listening = true;
              interrupted = false;
              heardAt = now;
              startCarrier();
            }
          }
          return handler.apply(this, arguments);
        };
      }
      var fallbacks = {
        play: function () { if (current) resume(current); },
        pause: function () { if (current) current.pause(); },
        seekto: function (details) {
          if (current && details && isFinite(details.seekTime)) current.currentTime = details.seekTime;
        },
      };
      function useFallbacks(on) {
        if (!setActionHandler) return;
        Object.keys(fallbacks).forEach(function (action) {
          if (pageHandlers[action]) return;
          try { setActionHandler.call(mediaSession, action, on ? userAction(action, fallbacks[action]) : null); } catch (e) {}
        });
      }
      try {
        setActionHandler = MediaSession.prototype.setActionHandler;
        MediaSession.prototype.setActionHandler = function (action, handler) {
          pageHandlers[action] = typeof handler === 'function' ? handler : null;
          if (pageHandlers[action]) handler = userAction(action, handler);
          else if ((background || resignAt) && fallbacks[action]) handler = userAction(action, fallbacks[action]);
          return setActionHandler.call(this, action, handler);
        };
        setPositionState = MediaSession.prototype.setPositionState;
        MediaSession.prototype.setPositionState = function () {
          pageSetsPosition = true;
          return setPositionState.apply(this, arguments);
        };
        var stateProperty = Object.getOwnPropertyDescriptor(MediaSession.prototype, 'playbackState');
        if (stateProperty && stateProperty.set) {
          setPlaybackState = stateProperty.set;
          Object.defineProperty(MediaSession.prototype, 'playbackState', {
            get: stateProperty.get,
            set: function (value) {
              pageSetsState = true;
              return setPlaybackState.call(this, value);
            },
            configurable: true,
            enumerable: stateProperty.enumerable,
          });
        }
      } catch (e) {}

      // The lock screen's progress and play state follow the real media.
      var lastSync = 0;
      function syncLockScreen() {
        var m = current;
        if (!background || !m || !mediaSession) return;
        lastSync = Date.now();
        if (setPlaybackState) {
          try {
            setPlaybackState.call(mediaSession, m.paused ? 'paused' : 'playing');
            ownState = true;
          } catch (e) {}
        }
        if (pageSetsPosition || !setPositionState || !isFinite(m.duration) || !(m.duration > 0)) return;
        try {
          setPositionState.call(mediaSession, {
            duration: m.duration,
            playbackRate: m.playbackRate || 1,
            position: Math.min(Math.max(m.currentTime || 0, 0), m.duration),
          });
          ownPosition = true;
        } catch (e) {}
      }

      // Hidden pages get no animation frames on iOS; players that wait for one to load the
      // next video would stall. In the background, frames come from a slow timer, including
      // the ones already requested when the app left the screen.
      var pendingFrames = {};
      function moveFramesToTimers() {}
      try {
        var raf = window.requestAnimationFrame.bind(window);
        var cancelRaf = window.cancelAnimationFrame.bind(window);
        window.requestAnimationFrame = function (callback) {
          if (background) return -setTimeout(function () { callback(performance.now()); }, 100);
          var id = raf(function (time) {
            delete pendingFrames[id];
            callback(time);
          });
          pendingFrames[id] = { callback: callback, timer: 0 };
          return id;
        };
        window.cancelAnimationFrame = function (id) {
          if (id < 0) return clearTimeout(-id);
          var frame = pendingFrames[id];
          if (frame) {
            clearTimeout(frame.timer);
            delete pendingFrames[id];
          }
          cancelRaf(id);
        };
        moveFramesToTimers = function () {
          Object.keys(pendingFrames).forEach(function (key) {
            var frame = pendingFrames[key];
            if (frame.timer) return;
            cancelRaf(Number(key));
            frame.timer = setTimeout(function () {
              delete pendingFrames[key];
              frame.callback(performance.now());
            }, 100);
          });
        };
      } catch (e) {}

      // Only media you can hear counts (muted previews are ignored).
      function audible(m) {
        return !!m && typeof m.play === 'function' && m !== carrier && !m.muted;
      }
      function inPage(m) {
        return audible(m) && m.isConnected;
      }
      // The media that is playing right now, going by the page itself.
      function playingNow() {
        if (started && inPage(started) && !started.paused && !started.ended) return started;
        try {
          var all = document.querySelectorAll('video, audio');
          for (var i = 0; i < all.length; i++) {
            if (audible(all[i]) && !all[i].paused && !all[i].ended) return all[i];
          }
        } catch (e) {}
        return null;
      }
      // Media started by the system or the page after the user paused it from outside the page
      // (in the background), or right as the app returns after that or after another app took
      // the audio. Anything else that starts may play.
      function unwanted(now) {
        if (now - gestureAt < 1500 || now - userActionAt < 2500) return false;
        return background ? userPaused : now < keepPausedUntil;
      }
      // It is paused again before the page hears of the play (these listeners come first), and
      // the page doesn't hear of that pause either: a player that is told "play" and then
      // "pause" out of the blue can be left waiting for data forever, its button gone.
      ['play', 'playing'].forEach(function (type) {
        window.addEventListener(type, function (e) {
          var m = e.target;
          if (!audible(m) || quiet() || !unwanted(Date.now())) return;
          e.stopImmediatePropagation();
          if (m.paused) return;
          silenced = m;
          try { m.pause(); } catch (err) {}
        }, true);
      });
      window.addEventListener('pause', function (e) {
        var m = e.target;
        if (!m || m !== silenced || !m.paused) return;
        silenced = null;
        if (m === started) started = null;
        e.stopImmediatePropagation();
      }, true);

      // The page plays what is being listened to muted, in the background (where the user can't
      // have muted it, and can't tap "unmute"): it gets its sound back. Through the site's own
      // player where there is a way (it would mute the element again), a few times per video.
      function keepSound(m) {
        if (!background || !listening || interrupted || userPaused || quiet()) return;
        if (m !== current || !m.muted || m.paused || unmutes >= 3) return;
        var now = Date.now();
        if (now - unmutedAt < 2000) return;
        unmutedAt = now;
        unmutes++;
        // (A video that gets its sound pauses the other players, like one that starts.)
        playAt = now;
        if (!siteUnmute()) {
          try { m.muted = false; } catch (e) {}
        }
      }
      document.addEventListener('emptied', function (e) { if (e.target === current) unmutes = 0; }, true);

      document.addEventListener('play', function (e) {
        var m = e.target;
        if (!audible(m) || quiet()) return;
        playAt = Date.now();
        started = m;
      }, true);
      document.addEventListener('playing', function (e) {
        var m = e.target;
        keepSound(m);
        if (!audible(m) || quiet()) return;
        var now = Date.now();
        started = m;
        current = m;
        if (!background) return;
        listening = true;
        interrupted = false;
        heardAt = now;
        mark(true);
        // A video started in the background can be stopped by the system right away.
        resumeUntil = now + 2000;
        startCarrier();
        syncLockScreen();
      }, true);
      document.addEventListener('pause', function (e) {
        var m = e.target;
        // Also for media that was muted in the meantime (which doesn't count below).
        if (m && m === started && m.paused) started = null;
        if (!audible(m) || quiet()) return;
        var now = Date.now();
        // Already playing again (this pause was undone before it was announced).
        if (!m.paused) return;
        if (m.ended) return;
        if (now - userPausedAt < 1500) return syncLockScreen();
        if (!background) {
          lastPause = { m: m, t: now };
          return;
        }
        if (!listening) {
          // Something that was playing when the app left, and wasn't seen to: the system has
          // just paused it.
          if (userPaused || now - leftAt > 3000 || userPausedAt > leftAt) return syncLockScreen();
          listening = true;
          current = m;
          heardAt = now;
          startCarrier();
          mark(true);
          return resumeAgain(m);
        }
        if (interrupted) return;
        // The carrier was stopped at the same moment, and not by a video starting: the system
        // took the audio.
        if (carrierOn && carrierPlayed && carrier && carrier.paused && now - playAt > 2000 && (!carrierPausedAt || now - carrierPausedAt < 1000)) {
          return systemTookAudio();
        }
        if (now < resumeUntil) return resumeAgain(m);
        if (m === current || !current || !current.isConnected) {
          // Paused by the page, not the user: a player switching to the next video pauses
          // first, and YouTube waits out a removed ad and sometimes leaves the next video
          // paused at the start. The page is kept running (so iOS doesn't suspend it in
          // the gap) and the media is started again if it stays paused.
          current = m;
          syncLockScreen();
          startCarrier();
          nudge(m, now);
        }
      }, true);
      document.addEventListener('ended', function (e) {
        var m = e.target;
        if (m && m === started) started = null;
        if (!audible(m) || quiet()) return;
        if (!background || !listening || interrupted) return;
        mark(true);
        syncLockScreen();
        startCarrier();
      }, true);
      ['seeked', 'ratechange', 'durationchange'].forEach(function (type) {
        document.addEventListener(type, function (e) { if (e.target === current) syncLockScreen(); }, true);
      });
      // Many videos start muted and get their sound with a tap: they count from then on. Muting
      // one says the user isn't listening to it.
      document.addEventListener('volumechange', function (e) {
        var m = e.target;
        if (!m || typeof m.play !== 'function' || m === carrier || quiet()) return;
        if (m.muted) {
          if (m === started) started = null;
        } else if (!m.paused && !m.ended && m !== started) {
          started = m;
          current = m;
          // With its sound it pauses the other players in the page, like a video that starts.
          playAt = Date.now();
        }
      }, true);
      var progressAt = -1;
      var carrierRetryAt = 0;
      document.addEventListener('timeupdate', function (e) {
        var m = e.target;
        keepSound(m);
        if (!background || !listening || !audible(m) || m.paused || quiet()) return;
        var now = Date.now();
        if (m !== current) {
          // Something else is what plays now.
          if (current && !current.paused && current.isConnected) return;
          current = m;
          progressAt = -1;
        }
        if (m.currentTime !== progressAt) {
          // It can be heard: whatever stopped the carrier is over.
          progressAt = m.currentTime;
          interrupted = false;
          heardAt = now;
          // And it got somewhere since it was last started again.
          if ((fights || nudges) && Math.abs(m.currentTime - fightFrom) > 5) {
            fights = 0;
            nudges = 0;
          }
          if (carrierOn && carrier && carrier.paused && now - carrierRetryAt > 3000) {
            carrierRetryAt = now;
            resume(carrier);
          }
        }
        if (now - lastSync > 10000) syncLockScreen();
        if (now - markedAt > 10000) mark(true);
      }, true);

      function applyAppState(state, fresh) {
        var now = Date.now();
        var wasBackground = background;
        if (state === 'inactive') {
          if (!background && !resignAt) {
            resignAt = now;
            atResign = playingNow();
            // Control Center's buttons count as the user's from here on.
            useFallbacks(true);
          }
        } else if (state === 'background' && !wasBackground) {
          background = true;
          useFallbacks(true);
          // What was playing when the app left the screen. The system's pause can land just
          // before the app is told, or be on its way; a pause from before the app started to
          // leave was the user's.
          var m = null;
          if (started && inPage(started) && !started.ended) {
            m = started;
          } else if (resignAt) {
            // Nothing but the system (or Control Center, which is the user) pauses it meanwhile.
            if (atResign && inPage(atResign) && userPausedAt < resignAt) m = atResign;
          } else {
            m = playingNow();
            if (!m && lastPause && userPausedAt < lastPause.t && now - lastPause.t < 1500 && inPage(lastPause.m)) m = lastPause.m;
          }
          listening = !!m && !quiet();
          interrupted = false;
          keepPausedUntil = 0;
          leftAt = now;
          fights = 0;
          nudges = 0;
          if (listening) {
            current = m;
            resumeUntil = now + 3000;
            heardAt = now;
            // (If it finished on the way out, the page gets its time to start the next one.)
            startCarrier();
            if (m.paused && !m.ended) resume(m);
            syncLockScreen();
            mark(true);
          } else if (fresh && !quiet() && marked()) {
            // The page before it was being listened to: this one is kept awake for its media.
            listening = true;
            heardAt = now;
            startCarrier();
          }
          moveFramesToTimers();
          lastPause = null;
        } else if ((state === 'foreground' || state === 'active') && wasBackground) {
          // ('active' alone also ends it: a page that loaded just as the app came back was told
          // 'background' and nothing since.)
          background = false;
          // Paused by the user from outside the page, or silenced by a call or another app: it
          // stays that way.
          keepPausedUntil = userPaused || interrupted ? now + 2500 : 0;
          listening = false;
          mark(false);
          interrupted = false;
          resumeUntil = 0;
          resignAt = 0;
          atResign = null;
          lastPause = null;
          stopCarrier();
          useFallbacks(false);
          // Back on screen the media drives the lock screen itself again.
          if (ownPosition) {
            ownPosition = false;
            try { setPositionState.call(mediaSession); } catch (e) {}
          }
          if (ownState) {
            ownState = false;
            try {
              setPlaybackState.call(mediaSession, pageSetsState ? (current && !current.paused ? 'playing' : 'paused') : 'none');
            } catch (e) {}
          }
        } else if (state === 'active') {
          resignAt = 0;
          atResign = null;
          useFallbacks(false);
        }
        // Players inside frames (embedded videos) get the news too.
        for (var i = 0; i < window.frames.length; i++) {
          try { window.frames[i].postMessage({ __shieldAppState: state, fresh: !!fresh }, '*'); } catch (e) {}
        }
      }
      window.addEventListener('message', function (e) {
        if (e.source === window.parent && window.parent !== window && e.data && typeof e.data.__shieldAppState === 'string') {
          applyAppState(e.data.__shieldAppState, e.data.fresh === true);
        }
      });
      // The sleep timer's pause: the user's, never undone.
      // Also used when headphones are unplugged; players in frames are told too.
      function userPause() {
        userPausedAt = Date.now();
        userPaused = true;
        listening = false;
        mark(false);
        stopCarrier();
        try { if (current) current.pause(); } catch (e) {}
        for (var i = 0; i < window.frames.length; i++) {
          try { window.frames[i].postMessage({ __stillwebUserPause: true }, '*'); } catch (e) {}
        }
      }
      window.addEventListener('message', function (e) {
        if (e.source === window.parent && window.parent !== window && e.data && e.data.__stillwebUserPause === true) userPause();
      });
      try {
        Object.defineProperty(window, '__stillwebUserPause', { value: userPause });
      } catch (e) {}
      try {
        Object.defineProperty(window, '__shieldAppState', {
          value: function (state, fresh) { applyAppState(String(state), fresh === true); }
        });
      } catch (e) {}

      if (window === window.top && /(^|\\.)youtube\\.com$/.test(location.hostname)) {
        // YouTube starts the next video muted when no tap led to it, and mutes the element
        // again when it is unmuted directly: its player's own unmute is used ("Tap to unmute").
        siteUnmute = function () {
          try {
            var player = document.querySelector('#movie_player, .html5-video-player');
            if (player && typeof player.unMute === 'function') {
              player.unMute();
              return true;
            }
            var button = document.querySelector('.ytp-unmute');
            if (button && button.offsetParent !== null) {
              button.click();
              return true;
            }
          } catch (e) {}
          return false;
        };
        var setTimer = window.setInterval.bind(window);
        setTimer(function () {
          try { if (typeof window._lact === 'number') window._lact = Date.now(); } catch (e) {}
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
    """,
    injectionTime: .atDocumentStart,
    forMainFrameOnly: false,
    in: .page
  )

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
  }

  deinit {
    observations.removeAll()
    downloadProgress.removeAll()
    appObservers.forEach(NotificationCenter.default.removeObserver)
    webView?.scrollView.delegate = nil
  }

  override func safeAreaInsetsDidChange() {
    super.safeAreaInsetsDidChange()
    applyChromeInsets()
  }

  /// Whether the page can scroll under the app's own bars: WebKit then keeps fixed headers and
  /// footers clear of them (iOS 26). Before that it only knows about the safe area.
  static var obscuredInsetsSupported: Bool {
    #if compiler(>=6.2)
    if #available(iOS 26.0, *) { return true }
    #endif
    return false
  }

  /// Edge to edge, like Safari: the page scrolls under the status bar and the app's bars.
  private func applyChromeInsets() {
    guard let webView else { return }
    let scroll = webView.scrollView
    var behavior: UIScrollView.ContentInsetAdjustmentBehavior = .never
    var inset = UIEdgeInsets.zero
    #if compiler(>=6.2)
    if #available(iOS 26.0, *) {
      // The safe area plus the bars: the layout viewport (fixed and sticky elements) shrinks
      // to the rest, and the page scrolls under all of it.
      var covered = UIEdgeInsets.zero
      if let chrome = chromeInsets {
        covered = UIEdgeInsets(
          top: max(0, safeAreaInsets.top + chrome.top), left: 0, bottom: max(0, safeAreaInsets.bottom + chrome.bottom), right: 0)
      }
      let before = webView.obscuredContentInsets
      if before != covered {
        // Less is covered: the page's area grows (see minimumZoomChanged).
        if covered.top + covered.bottom < before.top + before.bottom { areaGrewAt = Date() }
        webView.obscuredContentInsets = covered
      }
      inset = covered
    } else if let chrome = chromeInsets {
      behavior = .always
      inset = chrome
    }
    #else
    if let chrome = chromeInsets {
      // WebKit keeps fixed elements clear of the safe area only; the app lays the page out
      // above its bottom bar.
      behavior = .always
      inset = chrome
    }
    #endif
    if scroll.contentInsetAdjustmentBehavior != behavior { scroll.contentInsetAdjustmentBehavior = behavior }
    if scroll.contentInset != inset {
      scroll.contentInset = inset
      scroll.verticalScrollIndicatorInsets = inset
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    // A zero size (before the first layout) would reset the page's viewport.
    if bounds.width > 0, bounds.height > 0, webView?.frame != bounds { webView?.frame = bounds }
  }

  // MARK: - Props

  func applyProps() {
    if webView == nil {
      if let popupId, let popup = Self.pendingPopups.removeValue(forKey: popupId) {
        install(popup)
        // Its first page may not have committed yet; the address it was opened with counts.
        applyShields(for: popup.url ?? initialUrl.flatMap { URL(string: $0) })
        emitNavigationState()
      } else {
        createWebView()
        if let url = initialUrl { load(url) }
      }
    }
    guard let webView else { return }
    // Props arrive with every re-render; only real changes reach the page (a zoom change
    // relayouts it).
    let zoom = CGFloat(textZoom) / 100
    if webView.pageZoom != zoom { webView.pageZoom = zoom }
    // Pages that have a dark theme (prefers-color-scheme) show it exactly when the app is dark
    // and Dark websites is on; otherwise their light one, whatever the system appearance.
    let style: UIUserInterfaceStyle = forceDark ? .dark : .light
    if webView.overrideUserInterfaceStyle != style {
      // A change (not the first setting): pages that don't follow it live get re-checked.
      let changed = webView.overrideUserInterfaceStyle != .unspecified
      webView.overrideUserInterfaceStyle = style
      if changed { themeChanged() }
    }
    // Only one scroll view may answer the status bar tap.
    if webView.scrollView.scrollsToTop != active { webView.scrollView.scrollsToTop = active }
    // A background tab whose theme changed is checked once it's on screen.
    if active, themeCheckPending { scheduleThemeCheck() }
    // And one whose process ended while it was hidden is loaded again.
    reloadIfNeeded()
    applyChromeInsets()
  }

  /// Safari's user agent tokens. WKWebView's default UA leaves out "Version/x Safari/y", so
  /// sites (video sites especially) treat it as an embedded web view and serve broken or
  /// reduced layouts, icons and players. Safari's Version tracks the iOS major.minor.
  private static let safariApplicationName: String = {
    let parts = UIDevice.current.systemVersion.split(separator: ".")
    let major = parts.first.map(String.init) ?? "18"
    let minor = parts.count > 1 ? String(parts[1]) : "0"
    return "Version/\(major).\(minor) Mobile/15E148 Safari/604.1"
  }()

  /// Safari on a Mac, for sites the user asked to see as the desktop website.
  private static let desktopUserAgent: String = {
    let parts = UIDevice.current.systemVersion.split(separator: ".")
    let major = parts.first.map(String.init) ?? "18"
    let minor = parts.count > 1 ? String(parts[1]) : "0"
    return "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) " +
      "Version/\(major).\(minor) Safari/605.1.15"
  }()

  /// Hides the elements the user picked on this site (display: none, like a filter rule).
  private static func hideScript(_ selectors: [String]) -> String {
    let css = selectors.map { "\($0) { display: none !important; }" }.joined(separator: "\n")
    let literal = (try? JSONSerialization.data(withJSONObject: [css], options: []))
      .flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
    return """
    (function () {
      var css = \(literal)[0];
      function add() {
        var style = document.createElement('style');
        style.setAttribute('data-stillweb', 'hidden');
        style.textContent = css;
        (document.head || document.documentElement).appendChild(style);
      }
      if (document.documentElement) add(); else document.addEventListener('DOMContentLoaded', add);
    })();
    """
  }

  private func createWebView() {
    let config = WKWebViewConfiguration()
    // Private tabs share one in-memory jar (cleared when the last one closes).
    // Stillweb Plus profiles each have their own persistent store (iOS 17+).
    config.websiteDataStore = incognito
      ? ShieldEngine.shared.privateDataStore()
      : ShieldEngine.profileDataStore(profileId) ?? .default()
    config.userContentController = ShieldContentController()
    config.applicationNameForUserAgent = Self.safariApplicationName
    config.allowsInlineMediaPlayback = true
    // Players start video right after the tap that opened them (a page load or app route
    // later); requiring a gesture for *every* play() leaves them black with a spinner.
    config.mediaTypesRequiringUserActionForPlayback = []
    config.preferences.javaScriptCanOpenWindowsAutomatically = false
    // Like Safari: element fullscreen on iPad only. On iPhone, players fall back to the
    // native video fullscreen, which rotates, supports picture in picture and keeps playing.
    config.preferences.isElementFullscreenEnabled = UIDevice.current.userInterfaceIdiom == .pad
    config.userContentController.add(WeakScriptHandler(self), contentWorld: .defaultClient, name: "shieldStats")
    config.userContentController.add(WeakScriptHandler(self), contentWorld: .defaultClient, name: "shieldTouch")
    config.userContentController.add(WeakScriptHandler(self), contentWorld: .defaultClient, name: "shieldConsentFrame")
    config.userContentController.add(WeakScriptHandler(self), contentWorld: .defaultClient, name: "shieldGesture")
    config.userContentController.add(WeakScriptHandler(self), contentWorld: .defaultClient, name: "shieldMedia")
    (config.userContentController as? ShieldContentController)?.quiet = restored

    // The page's viewport is set up from the web view's first width; one created before the
    // view is laid out (zero width) can leave pages slightly zoomed in. Start at the window's
    // width; layoutSubviews applies the exact size.
    let initialFrame = bounds.width > 0 ? bounds : (window?.bounds ?? UIScreen.main.bounds)
    install(WKWebView(frame: initialFrame, configuration: config))
    applyShields(for: nil)
  }

  /// The media stopped because the user wanted it to (headphones unplugged): background play
  /// must not start it again.
  func markUserPause() {
    webView?.evaluateJavaScript("window.__stillwebUserPause && window.__stillwebUserPause()")
  }

  /// Sleep timer: pauses media in every frame, marked as the user's pause so background play
  /// doesn't resume it.
  func pauseAllMedia() {
    guard let webView else { return }
    webView.evaluateJavaScript(
      "(function(){try{if(window.__stillwebUserPause)window.__stillwebUserPause();}catch(e){}" +
        "document.querySelectorAll('video,audio').forEach(function(m){try{m.pause();}catch(e){}});})();"
    )
    webView.pauseAllMediaPlayback(completionHandler: nil)
  }

  /// Hooks a web view (new, or a page's pop-up) up to this view.
  private func install(_ wv: WKWebView) {
    SleepTimer.shared.register(self)
    HeadphoneWatcher.shared.start()
    // Not laid out yet: keep the starting width (see createWebView); layoutSubviews sizes it.
    if bounds.width > 0 { wv.frame = bounds }
    wv.navigationDelegate = self
    wv.uiDelegate = self
    wv.allowsBackForwardNavigationGestures = true
    // Safari's find bar, with match counts (Find in page).
    wv.isFindInteractionEnabled = true
    // The app's own bars already keep the page clear of the notch and home indicator; an
    // automatic inset on top of that shifts fixed headers and mis-sizes 100vh players.
    wv.scrollView.contentInsetAdjustmentBehavior = .never
    wv.scrollView.delegate = self
    wv.scrollView.scrollsToTop = active
    // A vertical drag doesn't drift sideways on pages that are wider than the screen.
    wv.scrollView.isDirectionalLockEnabled = true
    // Opaque, so pages without their own background get the default white (or dark, for
    // pages that support it) canvas instead of the app's chrome color behind dark text.
    wv.isOpaque = true
    // Pull down to reload, like Safari.
    let refresh = UIRefreshControl()
    refresh.addTarget(self, action: #selector(pullToRefresh), for: .valueChanged)
    wv.scrollView.refreshControl = refresh
    addSubview(wv)
    webView = wv

    let emit: (WKWebView) -> Void = { [weak self] _ in self?.emitNavigationState() }
    observations = [
      wv.observe(\.url) { v, _ in emit(v) },
      wv.observe(\.title) { v, _ in emit(v) },
      wv.observe(\.canGoBack) { v, _ in emit(v) },
      wv.observe(\.canGoForward) { v, _ in emit(v) },
      wv.observe(\.isLoading) { v, _ in
        if !v.isLoading { v.scrollView.refreshControl?.endRefreshing() }
        emit(v)
      },
      wv.scrollView.observe(\.minimumZoomScale, options: [.old, .new]) { [weak self] scroll, change in
        self?.minimumZoomChanged(scroll, from: change.oldValue, to: change.newValue)
      },
      wv.observe(\.estimatedProgress) { [weak self] v, _ in
        // WebKit reports tiny steps many times a second; the bar only needs visible ones.
        guard let self else { return }
        let progress = v.estimatedProgress
        guard progress >= 1 || progress < self.sentProgress || progress - self.sentProgress >= 0.05 else { return }
        self.sentProgress = progress
        self.onLoadProgress(["progress": progress])
      },
    ]

    // Tells the page when the app leaves or returns to the screen (background play). The
    // page hears that the app is about to leave before WebKit pauses its video, so it knows
    // what was playing at that moment.
    let center = NotificationCenter.default
    let states: [(Notification.Name, String)] = [
      (UIApplication.willResignActiveNotification, "inactive"),
      (UIApplication.didEnterBackgroundNotification, "background"),
      (UIApplication.willEnterForegroundNotification, "foreground"),
      (UIApplication.didBecomeActiveNotification, "active"),
    ]
    appObservers = states.map { name, state in
      center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        self?.sendAppState(state)
        if state == "foreground" || state == "active" { self?.reloadIfNeeded(returning: true) }
      }
    }
  }

  /// `fresh`: the page committed while the app is in the background.
  private func sendAppState(_ state: String, fresh: Bool = false) {
    guard ShieldEngine.shared.backgroundPlay else { return }
    webView?.evaluateJavaScript("window.__shieldAppState && window.__shieldAppState('\(state)', \(fresh))")
  }

  private var contentController: ShieldContentController? {
    webView?.configuration.userContentController as? ShieldContentController
  }

  // MARK: - Commands

  private var pendingNavigation: String?

  /// An address the app asks for (address bar, bookmarks, links): the user's doing, so the
  /// page may play media as usual.
  func navigate(_ string: String) {
    contentController?.quiet = false
    load(string)
  }

  private func load(_ string: String) {
    guard let webView else {
      initialUrl = string
      return
    }
    needsReload = false
    // Don't let the first page load unfiltered while rule lists are still compiling.
    let engine = ShieldEngine.shared
    if !engine.isReady && engine.lastError == nil {
      let alreadyWaiting = pendingNavigation != nil
      pendingNavigation = string
      if !alreadyWaiting {
        engine.whenReady { [weak self] in
          guard let self, let next = self.pendingNavigation else { return }
          self.pendingNavigation = nil
          self.load(next)
        }
      }
      return
    }
    guard var url = URL(string: string) else { return }
    if let upgraded = upgradeIfNeeded(url) { url = upgraded }
    applyShields(for: url)
    var request = URLRequest(url: url)
    request.setValue("1", forHTTPHeaderField: "Sec-GPC")
    webView.load(request)
  }

  /// Snapshot of the visible page as a small JPEG in Caches/thumbs; completes with a file URL.
  func captureThumbnail(key: String, completion: @escaping (String?) -> Void) {
    guard let webView, webView.bounds.width > 0 else { return completion(nil) }
    let config = WKSnapshotConfiguration()
    config.snapshotWidth = 360
    webView.takeSnapshot(with: config) { image, _ in
      guard let image else { return completion(nil) }
      // Encoding and writing stay off the main thread, so switching tabs doesn't stutter.
      DispatchQueue.global(qos: .userInitiated).async {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
          .appendingPathComponent("thumbs", isDirectory: true)
        let safe = key.map { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" ? $0 : "_" }
        let file = dir.appendingPathComponent(String(safe) + ".jpg")
        var written = false
        if let data = image.jpegData(compressionQuality: 0.7) {
          try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
          written = (try? data.write(to: file, options: .atomic)) != nil
        }
        DispatchQueue.main.async { completion(written ? file.absoluteString : nil) }
      }
    }
  }

  @objc private func pullToRefresh() {
    guard let webView, webView.url != nil else {
      webView?.scrollView.refreshControl?.endRefreshing()
      return
    }
    reload()
  }

  func goBack() {
    contentController?.quiet = false
    webView?.goBack()
  }

  func goForward() {
    contentController?.quiet = false
    webView?.goForward()
  }

  func stopLoading() { webView?.stopLoading() }
  func clearHistory() { /* WKWebView has no API to clear its back-forward list. */ }

  /// The user's reload (button, pull to refresh, Try again).
  func reload() {
    reload(quiet: false)
  }

  private func reload(quiet: Bool) {
    guard let webView else { return }
    needsReload = false
    // Force rules and scripts to be reapplied (shield settings may have changed).
    contentController?.appliedGeneration = -1
    contentController?.quiet = quiet
    applyShields(for: webView.url)
    if webView.url == nil, let first = initialUrl {
      // Nothing was committed yet (the process ended during the first load).
      load(first)
    } else {
      webView.reload()
    }
  }

  /// The page's process ended while the tab was hidden or the app was away: the page is
  /// loaded again when it is looked at, like in Safari.
  private var needsReload = false

  /// `returning`: the app is on its way back to the screen (it still counts as in the
  /// background while it is told so).
  private func reloadIfNeeded(returning: Bool = false) {
    guard needsReload, active, webView != nil else { return }
    guard returning || UIApplication.shared.applicationState == .active else { return }
    reload(quiet: true)
  }

  func evaluate(_ script: String, completion: @escaping (String?) -> Void) {
    guard let webView else { return completion(nil) }
    webView.evaluateJavaScript(script) { result, _ in
      guard let result, !(result is NSNull) else { return completion("null") }
      let data = try? JSONSerialization.data(withJSONObject: result, options: [.fragmentsAllowed])
      completion(data.flatMap { String(data: $0, encoding: .utf8) })
    }
  }

  /// Safari's find bar above the keyboard, with match counts and next/previous.
  func showFindNavigator() -> Bool {
    guard let interaction = webView?.findInteraction else { return false }
    interaction.presentFindNavigator(showingReplace: false)
    return true
  }

  func findInPage(_ query: String, backwards: Bool = false) {
    guard let webView, !query.isEmpty else { return }
    let config = WKFindConfiguration()
    config.backwards = backwards
    config.wraps = true
    lastQuery = query
    // WebKit only reports whether there was a match; count -1 means "unknown".
    webView.find(query, configuration: config) { [weak self] result in
      self?.onFindResult(["active": 0, "count": result.matchFound ? -1 : 0])
    }
  }

  private var lastQuery = ""

  func findNext(forward: Bool) { findInPage(lastQuery, backwards: !forward) }

  func clearFind() {
    lastQuery = ""
    webView?.findInteraction?.dismissFindNavigator()
    webView?.evaluateJavaScript("window.getSelection().removeAllRanges()")
  }

  // MARK: - Shields

  /// Attaches or detaches rule lists and installs the scriptlets for the page's host.
  /// Called before each main-frame navigation is allowed, so new documents pick them up.
  private func applyShields(for url: URL?) {
    guard let webView, let controller = webView.configuration.userContentController as? ShieldContentController else {
      return
    }
    let engine = ShieldEngine.shared
    let host = url?.host?.lowercased()
    let active = engine.shieldsEnabled(forHost: host)

    if active != shieldsActive || host != countedHost {
      if blockedOnPage != 0 {
        blockedOnPage = 0
        emitBlocked()
      }
    }
    shieldsActive = active
    countedHost = host

    if active {
      if !controller.rulesAttached || controller.appliedGeneration != engine.generation {
        controller.removeAllContentRuleLists()
        engine.ruleLists.forEach(controller.add)
        // Calm Mode (Stillweb Plus): the annoyance lists on top.
        if engine.calmMode { engine.calmRuleLists.forEach(controller.add) }
        controller.rulesAttached = !engine.ruleLists.isEmpty
      }
    } else if controller.rulesAttached {
      controller.removeAllContentRuleLists()
      controller.rulesAttached = false
    }

    if host != controller.appliedHost || controller.appliedGeneration != engine.generation || controller.quiet != controller.appliedQuiet {
      installUserScripts(in: controller, host: host, active: active)
    }
    controller.appliedHost = host
    controller.appliedGeneration = engine.generation
  }

  /// The scripts the tab's next documents (and frames) get, for `host` with shields `active`.
  private func installUserScripts(in controller: ShieldContentController, host: String?, active: Bool) {
    let engine = ShieldEngine.shared
    controller.removeAllUserScripts()
    controller.addUserScript(Self.statsScript)
    controller.addUserScript(Self.touchScript)
    controller.addUserScript(Self.mediaStateScript)
    controller.addUserScript(Self.privacyScript)
    if controller.quiet {
      controller.addUserScript(Self.quietScript)
      controller.addUserScript(Self.quietTouchScript)
    }
    controller.addUserScript(Self.inlineVideoScript)
    if engine.backgroundPlay { controller.addUserScript(Self.backgroundPlayScript) }
    if active, let host, let source = engine.scriptletSource(forHost: host) {
      controller.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: false, in: .page))
    }
    // Elements the user hid on this site (kept even with protection off for it).
    if let fix = engine.siteFix(forHost: host), !fix.hidden.isEmpty {
      controller.addUserScript(
        WKUserScript(source: Self.hideScript(fix.hidden), injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .defaultClient))
    }
    // Calm Mode: reject cookie pop-ups; consent dialogs in frames ask for it (consentFrameScript).
    if active, engine.calmMode, let source = engine.autoconsentSource {
      controller.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
      controller.addUserScript(Self.consentFrameScript)
    }
    controller.appliedQuiet = controller.quiet
  }

  private func upgradeIfNeeded(_ url: URL) -> URL? {
    guard ShieldEngine.shared.httpsUpgrade, url.scheme?.lowercased() == "http",
          let host = url.host?.lowercased(), !Self.httpOnlyHosts.contains(host),
          host != "localhost", !host.hasSuffix(".local"),
          host.rangeOfCharacter(from: CharacterSet.letters) != nil,
          var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
    components.scheme = "https"
    if components.port == 80 { components.port = nil }
    guard let upgraded = components.url else { return nil }
    pendingUpgradeURL = upgraded
    return upgraded
  }

  private func countBlocked(_ n: Int = 1, hosts: [String: Int] = [:]) {
    blockedOnPage += n
    blockedHosts.merge(hosts, uniquingKeysWith: +)
    ShieldEngine.shared.recordBlocked(n)
    emitBlocked()
  }

  private func emitBlocked() {
    onBlockedCountChange([
      "blocked": blockedOnPage,
      "totalBlocked": ShieldEngine.shared.totalBlocked,
      "hosts": blockedHosts,
    ])
    blockedHosts = [:]
  }

  private func emitNavigationState() {
    guard let webView else { return }
    let url = webView.url?.absoluteString ?? ""
    onNavigationStateChange([
      "url": url,
      "title": webView.title ?? "",
      "canGoBack": webView.canGoBack,
      "canGoForward": webView.canGoForward,
      "loading": webView.isLoading,
      "progress": webView.estimatedProgress,
      "shieldsActive": shieldsActive,
      "secure": webView.hasOnlySecureContent,
    ])
  }

  /// Frames with media playing (ids from mediaStateScript), and what the app was last told.
  private var playingFrames = Set<String>()
  private var sentPlaying = false

  private func emitMediaState() {
    let playing = !playingFrames.isEmpty
    guard playing != sentPlaying else { return }
    sentPlaying = playing
    onMediaStateChange(["playing": playing])
  }

  // MARK: - WKScriptMessageHandler

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    if message.name == "shieldStats", shieldsActive {
      let body = message.body as? [String: Any]
      let n = (body?["count"] as? Int) ?? (message.body as? Int) ?? 0
      let hosts = (body?["hosts"] as? [String: Any])?.compactMapValues { $0 as? Int } ?? [:]
      if n > 0 { countBlocked(n, hosts: hosts) }
    } else if message.name == "shieldConsentFrame" {
      // A consent dialog's frame: Calm Mode's script runs in that frame alone.
      let engine = ShieldEngine.shared
      guard shieldsActive, engine.calmMode, let source = engine.autoconsentSource, let target = message.webView else { return }
      target.evaluateJavaScript(source + "\n;void 0;", in: message.frameInfo, in: .page, completionHandler: nil)
    } else if message.name == "shieldMedia" {
      // A pop-up shares its opener's handlers: its media isn't this tab's.
      guard message.webView === webView, let body = message.body as? [String: Any], let id = body["id"] as? String else { return }
      if body["playing"] as? Bool == true { playingFrames.insert(id) } else { playingFrames.remove(id) }
      emitMediaState()
    } else if message.name == "shieldGesture" {
      // The user is using the page: what loads from here on may play. Frames this page adds
      // later get the scripts without the quiet ones, for the site they were set up for (the
      // web view's own address may already be the next page's).
      guard let controller = contentController else { return }
      controller.quiet = false
      if controller.appliedQuiet {
        installUserScripts(in: controller, host: controller.appliedHost, active: shieldsActive)
      }
    } else if message.name == "shieldTouch" {
      let src = message.body as? String ?? ""
      let url = URL(string: src)
      Self.touchedImage = ["http", "https", "data"].contains(url?.scheme?.lowercased() ?? "") ? url : nil
    }
  }

  // MARK: - WKNavigationDelegate

  /// Per-site fixes for the page about to load (desktop website, JavaScript off); then the
  /// usual navigation decision. WebKit calls this variant when it's implemented.
  func webView(
    _ webView: WKWebView,
    decidePolicyFor action: WKNavigationAction,
    preferences: WKWebpagePreferences,
    decisionHandler: @escaping (WKNavigationActionPolicy, WKWebpagePreferences) -> Void
  ) {
    if action.targetFrame?.isMainFrame ?? true, let url = action.request.url,
       ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
      let fix = ShieldEngine.shared.siteFix(forHost: url.host)
      let desktop = fix?.desktop ?? false
      preferences.preferredContentMode = desktop ? .desktop : .recommended
      preferences.allowsContentJavaScript = !(fix?.noScript ?? false)
      let agent = desktop ? Self.desktopUserAgent : nil
      if webView.customUserAgent != agent { webView.customUserAgent = agent }
    }
    self.webView(webView, decidePolicyFor: action) { policy in decisionHandler(policy, preferences) }
  }

  func webView(
    _ webView: WKWebView,
    decidePolicyFor action: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    guard let url = action.request.url else { return decisionHandler(.cancel) }
    let scheme = url.scheme?.lowercased() ?? ""
    let isMainFrame = action.targetFrame?.isMainFrame ?? true

    // <a download> links.
    if action.shouldPerformDownload { return decisionHandler(.download) }

    if !["http", "https", "about", "data", "blob"].contains(scheme) {
      decisionHandler(.cancel)
      if action.navigationType == .linkActivated {
        onExternalLink(["url": url.absoluteString])
      } else if shieldsActive {
        // Script-driven jumps to app stores / other apps.
        countBlocked(hosts: url.host.map { [$0.lowercased(): 1] } ?? [:])
        onPopupBlocked(["url": url.absoluteString, "kind": "redirect"])
      }
      return
    }

    // A server sending us from https back to http on the same host: respect it, don't loop.
    if isMainFrame, scheme == "http", let pending = pendingUpgradeURL, pending.host == url.host {
      if let host = url.host?.lowercased() { Self.httpOnlyHosts.insert(host) }
      pendingUpgradeURL = nil
      applyShields(for: url)
      return decisionHandler(.allow)
    }

    if isMainFrame && (scheme == "http" || scheme == "https") {
      // Back and forward (also by swiping) are the user's doing, like a tapped link.
      if action.navigationType == .backForward { contentController?.quiet = false }
      if action.request.httpMethod == "GET", let upgraded = upgradeIfNeeded(url) {
        decisionHandler(.cancel)
        applyShields(for: upgraded)
        webView.load(URLRequest(url: upgraded))
        return
      }
      applyShields(for: url)
    }
    decisionHandler(.allow)
  }

  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationResponse: WKNavigationResponse,
    decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
  ) {
    // Files the server marks as attachments are downloaded, like in Safari.
    let disposition = (navigationResponse.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition")
    let attachment = disposition?.trimmingCharacters(in: .whitespaces).lowercased().hasPrefix("attachment") ?? false
    decisionHandler(navigationResponse.canShowMIMEType && !attachment ? .allow : .download)
  }

  func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
    download.delegate = self
  }

  func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
    download.delegate = self
  }

  func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
    setChrome(collapsed: false)
    onLoadStart(["url": webView.url?.absoluteString ?? ""])
  }

  /// A page that loads while the app is in the background (the next video of a playlist on
  /// a site without in-page navigation) must know it from the start.
  func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
    zoomBeforePush = nil
    // The page before it took its media with it.
    playingFrames.removeAll()
    emitMediaState()
    switch UIApplication.shared.applicationState {
    case .background: sendAppState("background", fresh: true)
    case .inactive: sendAppState("inactive")
    default: break
    }
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    if webView.url == pendingUpgradeURL { pendingUpgradeURL = nil }
    onLoadEnd(["url": webView.url?.absoluteString ?? ""])
    emitNavigationState()
    if active, themeCheckPending || themeReloads > 0 { scheduleThemeCheck() }
  }

  // MARK: - Light and dark

  /// Reloads made for the current theme change (at most two).
  private var themeReloads = 0
  private var themeCheckPending = false
  /// One check at a time: props arrive with every re-render, and two checks overlapping
  /// would both reload (spending both tries on one load).
  private var themeCheckBusy = false
  /// Sites that didn't follow the theme even after reloading (always light or always dark):
  /// never reloaded for it again (kept across launches, the most recent 300).
  private static var themeIgnoredHosts: [String] = UserDefaults.standard.stringArray(forKey: "theme.ignoredHosts") ?? [] {
    didSet { UserDefaults.standard.set(themeIgnoredHosts, forKey: "theme.ignoredHosts") }
  }

  /// Many sites switch with the theme by themselves; some (YouTube) pick it on their server
  /// from a cookie that their own script only updates on the next load, so the page that's
  /// open keeps the old theme. Those are reloaded, up to twice.
  private func themeChanged() {
    themeReloads = 0
    themeCheckPending = true
    if active { scheduleThemeCheck() }
  }

  private func scheduleThemeCheck() {
    guard !themeCheckBusy else { return }
    themeCheckBusy = true
    // Sites that follow the theme live have updated by then.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in self?.checkTheme() }
  }

  private func checkTheme() {
    guard active, let webView, !webView.isLoading else {
      // Tried again when the page finishes loading or the tab is shown.
      themeCheckBusy = false
      return
    }
    themeCheckPending = false
    guard let url = webView.url, ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
          let host = url.host?.lowercased(), !Self.themeIgnoredHosts.contains(host) else {
      themeReloads = 0
      themeCheckBusy = false
      return
    }
    webView.evaluateJavaScript(Self.themeCheckScript) { [weak self] result, _ in
      guard let self else { return }
      self.themeCheckBusy = false
      guard (result as? String) == "mismatch" else {
        // Matches (or media is playing: never interrupted).
        self.themeReloads = 0
        return
      }
      guard self.themeReloads < 2 else {
        Self.themeIgnoredHosts = Array((Self.themeIgnoredHosts + [host]).suffix(300))
        self.themeReloads = 0
        return
      }
      self.themeReloads += 1
      // Nothing was playing (the check says so), and the reload must not start it.
      self.reload(quiet: true)
    }
  }

  /// "mismatch" when the page's background is dark in light mode or light in dark mode,
  /// "playing" while audio or video plays, "ok" otherwise.
  private static let themeCheckScript = """
  (function () {
    try {
      // Reader view is styled by the app itself.
      if (document.documentElement.hasAttribute('data-stillweb-reader')) return 'ok';
      var media = document.querySelectorAll('video, audio');
      for (var i = 0; i < media.length; i++) if (!media[i].paused && !media[i].ended) return 'playing';
      function parse(c) {
        var m = /rgba?\\(([^)]+)\\)/.exec(c || '');
        if (!m) return null;
        var p = m[1].split(/[\\s,\\/]+/).filter(Boolean).map(parseFloat);
        return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
      }
      function luminance(c) {
        function ch(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
        return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
      }
      var bg = null, els = [document.body, document.documentElement];
      for (var j = 0; j < els.length && !bg; j++) {
        var c = els[j] && parse(getComputedStyle(els[j]).backgroundColor);
        if (c && c.a > 0.5) bg = c;
      }
      if (!bg) return 'ok';
      var pageDark = luminance(bg) < 0.2;
      return pageDark !== matchMedia('(prefers-color-scheme: dark)').matches ? 'mismatch' : 'ok';
    } catch (e) {
      return 'ok';
    }
  })()
  """

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    webView.scrollView.refreshControl?.endRefreshing()
    onLoadEnd(["url": webView.url?.absoluteString ?? ""])
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    webView.scrollView.refreshControl?.endRefreshing()
    let nsError = error as NSError
    if nsError.code == NSURLErrorCancelled { return }
    // "Frame load interrupted": the navigation turned into a download.
    if nsError.domain == "WebKitErrorDomain" && nsError.code == 102 { return }
    let failed = (nsError.userInfo[NSURLErrorFailingURLErrorKey] as? URL) ?? webView.url
    if let failed, let pending = pendingUpgradeURL, failed.host == pending.host {
      pendingUpgradeURL = nil
      if let host = failed.host?.lowercased() { Self.httpOnlyHosts.insert(host) }
      var components = URLComponents(url: failed, resolvingAgainstBaseURL: false)
      components?.scheme = "http"
      if let http = components?.url {
        applyShields(for: http)
        webView.load(URLRequest(url: http))
        return
      }
    }
    onLoadError(["url": failed?.absoluteString ?? "", "code": nsError.code, "description": nsError.localizedDescription])
  }

  /// Sign-in prompts for sites protected with HTTP authentication.
  func webView(
    _ webView: WKWebView,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    let method = challenge.protectionSpace.authenticationMethod
    let passwordMethods = [NSURLAuthenticationMethodHTTPBasic, NSURLAuthenticationMethodHTTPDigest, NSURLAuthenticationMethodNTLM]
    guard passwordMethods.contains(method), challenge.previousFailureCount < 3, active else {
      return completionHandler(passwordMethods.contains(method) ? .cancelAuthenticationChallenge : .performDefaultHandling, nil)
    }
    let host = challenge.protectionSpace.host
    let alert = UIAlertController(title: "Sign in to \(host)", message: challenge.protectionSpace.realm, preferredStyle: .alert)
    alert.addTextField { $0.placeholder = "User name"; $0.textContentType = .username; $0.autocapitalizationType = .none }
    alert.addTextField { $0.placeholder = "Password"; $0.textContentType = .password; $0.isSecureTextEntry = true }
    alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(.cancelAuthenticationChallenge, nil) })
    alert.addAction(UIAlertAction(title: "Sign In", style: .default) { [weak alert] _ in
      let user = alert?.textFields?[0].text ?? ""
      let password = alert?.textFields?[1].text ?? ""
      completionHandler(.useCredential, URLCredential(user: user, password: password, persistence: .forSession))
    })
    if !present(alert) { completionHandler(.cancelAuthenticationChallenge, nil) }
  }

  func webViewDidClose(_ webView: WKWebView) {
    onCloseRequest(["reason": "script"])
  }

  private var terminations: [Date] = []

  /// The page's process crashed or was ended to free memory (iOS does that to apps that are
  /// away). The page on screen is loaded again, without starting its media; hidden tabs and
  /// an app that is away wait until they are looked at, so nothing loads (or plays) behind
  /// the user's back and the memory stays free. A page that keeps crashing while it's being
  /// used gets the error page after a third time within a minute.
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    webView.scrollView.refreshControl?.endRefreshing()
    playingFrames.removeAll()
    emitMediaState()
    guard active, UIApplication.shared.applicationState == .active else {
      needsReload = true
      return
    }
    let now = Date()
    terminations = terminations.filter { now.timeIntervalSince($0) < 60 } + [now]
    if terminations.count >= 3 {
      terminations.removeAll()
      onLoadError(["url": webView.url?.absoluteString ?? initialUrl ?? "", "code": -10001, "description": "PAGE_CRASHED"])
    } else {
      reload(quiet: true)
    }
  }

  // MARK: - WKUIDelegate

  func webView(
    _ webView: WKWebView,
    createWebViewWith configuration: WKWebViewConfiguration,
    for action: WKNavigationAction,
    windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    // javaScriptCanOpenWindowsAutomatically=false means only user-initiated windows get here.
    let id = UUID().uuidString
    let popup = WKWebView(frame: webView.bounds, configuration: configuration)
    Self.pendingPopups[id] = popup
    // Never shown (e.g. the tab couldn't open): let it go.
    DispatchQueue.main.asyncAfter(deadline: .now() + 30) { Self.pendingPopups.removeValue(forKey: id) }
    onOpenWindow(["url": action.request.url?.absoluteString ?? "", "incognito": incognito, "popupId": id])
    return popup
  }

  // Page dialogs (alert, confirm, prompt), shown like Safari's. Background tabs can't show
  // them; they get the "dismissed" answer straight away.

  func webView(
    _ webView: WKWebView,
    runJavaScriptAlertPanelWithMessage message: String,
    initiatedByFrame frame: WKFrameInfo,
    completionHandler: @escaping () -> Void
  ) {
    let alert = UIAlertController(title: dialogTitle(frame), message: message, preferredStyle: .alert)
    alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
    if !present(alert) { completionHandler() }
  }

  func webView(
    _ webView: WKWebView,
    runJavaScriptConfirmPanelWithMessage message: String,
    initiatedByFrame frame: WKFrameInfo,
    completionHandler: @escaping (Bool) -> Void
  ) {
    let alert = UIAlertController(title: dialogTitle(frame), message: message, preferredStyle: .alert)
    alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
    alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
    if !present(alert) { completionHandler(false) }
  }

  func webView(
    _ webView: WKWebView,
    runJavaScriptTextInputPanelWithPrompt prompt: String,
    defaultText: String?,
    initiatedByFrame frame: WKFrameInfo,
    completionHandler: @escaping (String?) -> Void
  ) {
    let alert = UIAlertController(title: dialogTitle(frame), message: prompt, preferredStyle: .alert)
    alert.addTextField { $0.text = defaultText }
    alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
    alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak alert] _ in
      completionHandler(alert?.textFields?.first?.text ?? "")
    })
    if !present(alert) { completionHandler(nil) }
  }

  private func dialogTitle(_ frame: WKFrameInfo) -> String? {
    let host = frame.securityOrigin.host
    return host.isEmpty ? nil : host
  }

  /// Presents system UI for the visible tab; false if it can't be shown (tab in the background).
  @discardableResult
  private func present(_ controller: UIViewController) -> Bool {
    guard active, window != nil, let top = topViewController(for: self) else { return false }
    if let popover = controller.popoverPresentationController {
      popover.sourceView = self
      popover.sourceRect = CGRect(x: bounds.midX, y: bounds.midY, width: 1, height: 1)
    }
    top.present(controller, animated: true)
    return true
  }

  // Long-press menu like Safari's: links (new tabs open in the app) and images.

  func webView(
    _ webView: WKWebView,
    contextMenuConfigurationForElement elementInfo: WKContextMenuElementInfo,
    completionHandler: @escaping (UIContextMenuConfiguration?) -> Void
  ) {
    let link = elementInfo.linkURL
    let image = Self.touchedImage
    guard link != nil || image != nil else { return completionHandler(nil) }
    let configuration = UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
      var sections: [UIMenuElement] = []
      if let link, let items = self?.linkMenuItems(link) {
        sections.append(UIMenu(title: "", options: .displayInline, children: items))
      }
      if let image, let items = self?.imageMenuItems(image) {
        sections.append(UIMenu(title: "", options: .displayInline, children: items))
      }
      return UIMenu(title: link?.absoluteString ?? "", children: sections)
    }
    completionHandler(configuration)
  }

  private func linkMenuItems(_ url: URL) -> [UIMenuElement] {
    var items: [UIMenuElement] = []
    if ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
      let link = url.absoluteString
      items.append(UIAction(title: incognito ? "Open in New Private Tab" : "Open in New Tab",
                            image: UIImage(systemName: "plus.square.on.square")) { [weak self] _ in
        self?.onLinkAction(["action": "open", "url": link])
      })
      if !incognito {
        items.append(UIAction(title: "Open in Private Tab", image: UIImage(systemName: "hand.raised")) { [weak self] _ in
          self?.onLinkAction(["action": "openPrivate", "url": link])
        })
      }
      items.append(UIAction(title: "Download Linked File", image: UIImage(systemName: "arrow.down.circle")) { [weak self] _ in
        self?.webView?.startDownload(using: URLRequest(url: url)) { download in
          download.delegate = self
        }
      })
    }
    items.append(UIAction(title: "Copy Link", image: UIImage(systemName: "doc.on.doc")) { _ in
      UIPasteboard.general.url = url
    })
    items.append(UIAction(title: "Share…", image: UIImage(systemName: "square.and.arrow.up")) { [weak self] _ in
      self?.present(UIActivityViewController(activityItems: [url], applicationActivities: nil))
    })
    return items
  }

  private func imageMenuItems(_ url: URL) -> [UIMenuElement] {
    var items: [UIMenuElement] = []
    if ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
      items.append(UIAction(title: "Open Image in New Tab", image: UIImage(systemName: "photo")) { [weak self] _ in
        self?.onLinkAction(["action": "open", "url": url.absoluteString])
      })
    }
    items.append(UIAction(title: "Save to Photos", image: UIImage(systemName: "square.and.arrow.down")) { [weak self] _ in
      self?.loadImage(url) { image in
        if let image { UIImageWriteToSavedPhotosAlbum(image, nil, nil, nil) }
      }
    })
    items.append(UIAction(title: "Copy Image", image: UIImage(systemName: "doc.on.doc")) { [weak self] _ in
      self?.loadImage(url) { image in
        if let image { UIPasteboard.general.image = image }
      }
    })
    items.append(UIAction(title: "Share Image…", image: UIImage(systemName: "square.and.arrow.up")) { [weak self] _ in
      self?.loadImage(url) { image in
        guard let self, let image else { return }
        self.present(UIActivityViewController(activityItems: [image], applicationActivities: nil))
      }
    })
    return items
  }

  /// Fetches an image the page shows (completes on the main thread). Nothing is cached on
  /// disk and no cookies are sent; like browsers, only the page's site goes as the referrer
  /// (never the full address, which can carry what was searched or read).
  private func loadImage(_ url: URL, completion: @escaping (UIImage?) -> Void) {
    if url.scheme?.lowercased() == "data" {
      return completion((try? Data(contentsOf: url)).flatMap(UIImage.init(data:)))
    }
    var request = URLRequest(url: url)
    if let page = webView?.url, let scheme = page.scheme, let host = page.host,
       !(scheme == "https" && url.scheme?.lowercased() == "http") {
      let port = page.port.map { ":\($0)" } ?? ""
      request.setValue("\(scheme)://\(host)\(port)/", forHTTPHeaderField: "Referer")
    }
    let session = URLSession(configuration: .ephemeral)
    session.dataTask(with: request) { data, _, _ in
      let image = data.flatMap(UIImage.init(data:))
      DispatchQueue.main.async { completion(image) }
    }.resume()
    session.finishTasksAndInvalidate()
  }

  /// Tapping the menu's preview opens the link here.
  func webView(
    _ webView: WKWebView,
    contextMenuForElement elementInfo: WKContextMenuElementInfo,
    willCommitWithAnimator animator: UIContextMenuInteractionCommitAnimating
  ) {
    guard let url = elementInfo.linkURL else { return }
    animator.addCompletion { [weak self] in self?.navigate(url.absoluteString) }
  }

  // MARK: - Scrolling

  private var chromeCollapsed = false
  private var scrollAnchor: CGFloat = 0
  private var lastScrollY: CGFloat = 0

  /// The app showed or shrank the bars itself (e.g. the shrunken address was tapped).
  func syncChrome(collapsed: Bool) {
    chromeCollapsed = collapsed
    scrollAnchor = webView?.scrollView.contentOffset.y ?? 0
  }

  private func setChrome(collapsed: Bool) {
    guard collapsed != chromeCollapsed else { return }
    chromeCollapsed = collapsed
    onChromeChange(["collapsed": collapsed])
  }

  /// Like Safari: scrolling down the page shrinks the bars, scrolling back up (or reaching
  /// the top or the end) brings them back. Only the user's own scrolling counts.
  func scrollViewDidScroll(_ scrollView: UIScrollView) {
    let y = scrollView.contentOffset.y
    defer { lastScrollY = y }
    guard scrollView.isDragging || scrollView.isDecelerating else { return }
    // With edge-to-edge insets the top of the page is at -inset, not 0.
    let insets = scrollView.adjustedContentInset
    let minY = -insets.top
    let maxY = scrollView.contentSize.height - scrollView.bounds.height + insets.bottom
    if y <= minY || maxY - minY < 120 {
      setChrome(collapsed: false)
      scrollAnchor = y
      return
    }
    if y > maxY + 40 {
      setChrome(collapsed: false)
      return
    }
    // Measure each stretch from where the scrolling direction last changed.
    if (y > lastScrollY) != (lastScrollY > scrollAnchor) { scrollAnchor = lastScrollY }
    if y - scrollAnchor > 40 {
      setChrome(collapsed: true)
    } else if scrollAnchor - y > 40 {
      setChrome(collapsed: false)
    }
  }

  func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
    scrollAnchor = scrollView.contentOffset.y
  }

  // MARK: - Zoom

  /// When the page's area last grew (the app's bars cover less of it).
  private var areaGrewAt = Date.distantPast
  /// The zoom a page had before WebKit pushed it up (see minimumZoomChanged).
  private var zoomBeforePush: CGFloat?

  /// WebKit raises a page's minimum zoom while its content is shorter than the area it has to
  /// fill. That is the case for a moment whenever the area grows and the page hasn't laid
  /// itself out again (pages that are exactly one screen tall: most app-like sites). The
  /// zoom is pushed up with the minimum and then stays there, so the page is left slightly
  /// zoomed in, wider than the screen, and can be pushed sideways. The zoom from before is
  /// put back as soon as the minimum comes down again, unless the user has zoomed since.
  private func minimumZoomChanged(_ scroll: UIScrollView, from old: CGFloat?, to new: CGFloat?) {
    guard let old, let new, abs(new - old) > 0.001 else { return }
    if new > old {
      let justGrew = Date().timeIntervalSince(areaGrewAt) < 2
      if justGrew, zoomBeforePush == nil, scroll.zoomScale < new - 0.001, !userIsZooming(scroll) {
        zoomBeforePush = scroll.zoomScale
      }
    } else if let before = zoomBeforePush {
      let target = max(new, before)
      // After WebKit has finished applying its own update.
      DispatchQueue.main.async { [weak self, weak scroll] in
        guard let self, let scroll, self.zoomBeforePush != nil, !self.userIsZooming(scroll) else { return }
        if scroll.zoomScale > target + 0.001 { scroll.setZoomScale(target, animated: false) }
        if target <= before + 0.001 { self.zoomBeforePush = nil }
      }
    }
  }

  private func userIsZooming(_ scroll: UIScrollView) -> Bool {
    let pinch = scroll.pinchGestureRecognizer?.state
    return scroll.isZooming || scroll.isZoomBouncing || pinch == .began || pinch == .changed
  }

  /// A pinch or a double tap: the zoom is the user's from here on.
  func scrollViewWillBeginZooming(_ scrollView: UIScrollView, with view: UIView?) {
    zoomBeforePush = nil
  }

  func scrollViewShouldScrollToTop(_ scrollView: UIScrollView) -> Bool {
    setChrome(collapsed: false)
    return true
  }

  // MARK: - WKDownloadDelegate

  func download(
    _ download: WKDownload,
    decideDestinationUsing response: URLResponse,
    suggestedFilename: String,
    completionHandler: @escaping (URL?) -> Void
  ) {
    let fm = FileManager.default
    // Private tabs with the vault on (Stillweb Plus) keep their downloads out of the Files app.
    let dir = incognito && ShieldEngine.shared.vault
      ? ShieldEngine.vaultDownloadsDir
      : fm.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("Downloads", isDirectory: true)
    try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
    let name = suggestedFilename.isEmpty ? "download" : suggestedFilename
    var destination = dir.appendingPathComponent(name)
    var n = 1
    let base = destination.deletingPathExtension().lastPathComponent
    let ext = destination.pathExtension
    while fm.fileExists(atPath: destination.path) {
      destination = dir.appendingPathComponent(ext.isEmpty ? "\(base) (\(n))" : "\(base) (\(n)).\(ext)")
      n += 1
    }
    let key = ObjectIdentifier(download)
    let path = destination.path
    downloadPaths[key] = path
    let total = response.expectedContentLength
    ShieldEngine.shared.updateDownload(path: path, status: "running", bytes: 0, total: max(total, 0))
    downloadProgress[key] = download.progress.observe(\.completedUnitCount) { progress, _ in
      DispatchQueue.main.async {
        ShieldEngine.shared.updateDownload(
          path: path, status: "running", bytes: progress.completedUnitCount, total: max(progress.totalUnitCount, 0))
      }
    }
    onDownloadRequest([
      "url": response.url?.absoluteString ?? "",
      "userAgent": "",
      "contentDisposition": "attachment; filename=\"\(destination.lastPathComponent)\"",
      "mimeType": response.mimeType ?? "",
      "contentLength": Double(total),
      "incognito": incognito,
      "handledNatively": true,
      "filePath": path,
    ])
    completionHandler(destination)
  }

  func downloadDidFinish(_ download: WKDownload) {
    finishDownload(download, status: "done")
  }

  func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
    finishDownload(download, status: "failed")
  }

  private func finishDownload(_ download: WKDownload, status: String) {
    let key = ObjectIdentifier(download)
    downloadProgress.removeValue(forKey: key)
    guard let path = downloadPaths.removeValue(forKey: key) else { return }
    let bytes = download.progress.completedUnitCount
    ShieldEngine.shared.updateDownload(path: path, status: status, bytes: bytes, total: bytes)
  }
}
