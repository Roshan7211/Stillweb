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

  var initialUrl: String?
  var incognito = false
  /// Stillweb Plus profile (nil = the default one); fixed when the web view is created.
  var profileId: String?
  var forceDark = false
  var textZoom = 100
  /// The tab on screen: only it may show page dialogs or scroll to top from the status bar.
  var active = true
  /// Adopts the web view created for a page's window.open instead of making a new one.
  var popupId: String?

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

  /// Keeps pages reporting "visible" so audio continues in the background (web/shieldjs/background-play.js).
  /// iOS also pauses video with sound when the app leaves the screen and suspends a page once
  /// nothing plays; with `__shieldAppState`, called by the app (and passed on to frames), the
  /// script plays again what the system paused, keeps animation-frame callbacks running and
  /// bridges the gap to the next video of a playlist with silence.
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

      // In the background iOS pauses video with sound, suspends the page as soon as nothing
      // plays (so the next video of a playlist never starts) and doesn't let video on a
      // hidden page drive the lock screen (it keeps showing the previous video). The app
      // calls __shieldAppState(true/false) when it leaves / returns to the screen; then a
      // silent audio player keeps the page running and carries the lock screen, with the
      // page's own title and artwork plus the real video's position and play state.
      var background = false;
      var resumeUntil = 0;
      var recent = [];
      var userPausedAt = 0;
      var current = null; // the media being listened to
      function resume(m) {
        try { var r = m.play(); if (r && r.catch) r.catch(function () {}); } catch (e) {}
      }

      var keepAlive = null;
      var keepAliveStarted = 0;
      var gapTimer = 0;
      var noCarrier = null; // media that can't play alongside the silent player
      function silentWav() {
        var rate = 8000, n = rate, buf = new ArrayBuffer(44 + n), v = new DataView(buf);
        var text = function (at, str) { for (var i = 0; i < str.length; i++) v.setUint8(at + i, str.charCodeAt(i)); };
        text(0, 'RIFF'); v.setUint32(4, 36 + n, true); text(8, 'WAVE'); text(12, 'fmt ');
        v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
        v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
        text(36, 'data'); v.setUint32(40, n, true);
        for (var i = 0; i < n; i++) v.setUint8(44 + i, 128);
        return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
      }
      function startKeepAlive() {
        clearTimeout(gapTimer);
        if (current && current === noCarrier) return;
        try {
          if (!keepAlive) {
            keepAlive = new Audio(silentWav());
            keepAlive.loop = true;
          }
          if (keepAlive.paused) {
            keepAliveStarted = Date.now();
            resume(keepAlive);
          }
        } catch (e) {}
      }
      function stopKeepAlive() {
        clearTimeout(gapTimer);
        if (keepAlive && !keepAlive.paused) keepAlive.pause();
      }

      // Lock screen and Control Center buttons. The page's own handlers are used as they
      // are (its pause marked as the user's, which is never undone); for the basic buttons
      // it doesn't handle, the app's act on the media being listened to (otherwise they
      // would control the silent player).
      var mediaSession = navigator.mediaSession;
      var setActionHandler = null;
      var setPositionState = null;
      var pageHandlers = {};
      var pageSetsPosition = false;
      var ownPosition = false;
      function userAction(action, handler) {
        if (action !== 'pause' && action !== 'stop') return handler;
        return function () {
          userPausedAt = Date.now();
          stopKeepAlive();
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
          else if (background && fallbacks[action]) handler = userAction(action, fallbacks[action]);
          return setActionHandler.call(this, action, handler);
        };
        setPositionState = MediaSession.prototype.setPositionState;
        MediaSession.prototype.setPositionState = function () {
          pageSetsPosition = true;
          return setPositionState.apply(this, arguments);
        };
      } catch (e) {}

      // The lock screen's progress and play state follow the real media.
      var lastSync = 0;
      function syncLockScreen() {
        var m = current;
        if (!background || !m || !mediaSession) return;
        lastSync = Date.now();
        try { mediaSession.playbackState = m.paused ? 'paused' : 'playing'; } catch (e) {}
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
        return !!m && typeof m.play === 'function' && m !== keepAlive && !m.muted;
      }

      document.addEventListener('pause', function (e) {
        var m = e.target;
        if (!audible(m) || m.ended) return;
        var now = Date.now();
        // Starting the silent player stopped this media (it can't play alongside it): give
        // way, and leave this media to drive the lock screen itself.
        if (background && m === current && keepAlive && !keepAlive.paused && now - keepAliveStarted < 1000) {
          noCarrier = m;
          stopKeepAlive();
          return resume(m);
        }
        if (now - userPausedAt < 1500) return syncLockScreen();
        if (now < resumeUntil) return resume(m);
        recent.push({ m: m, t: now });
        if (recent.length > 4) recent.shift();
        if (background && m === current) {
          // Paused by the page itself (not the user, not the system): show it as paused.
          stopKeepAlive();
          syncLockScreen();
        }
      }, true);
      document.addEventListener('playing', function (e) {
        var m = e.target;
        if (!audible(m)) return;
        current = m;
        if (!background) return;
        // A video started in the background can be stopped by the system right away.
        resumeUntil = Date.now() + 2000;
        startKeepAlive();
        syncLockScreen();
      }, true);
      document.addEventListener('ended', function (e) {
        if (!background || !audible(e.target)) return;
        // Bridge the gap to the next video; nothing followed after a minute: let the page rest.
        startKeepAlive();
        syncLockScreen();
        gapTimer = setTimeout(stopKeepAlive, 60000);
      }, true);
      // A new source (the next video in the same player) gets another chance at the carrier.
      document.addEventListener('emptied', function (e) { if (e.target === noCarrier) noCarrier = null; }, true);
      ['seeked', 'ratechange', 'durationchange'].forEach(function (type) {
        document.addEventListener(type, function (e) { if (e.target === current) syncLockScreen(); }, true);
      });
      document.addEventListener('timeupdate', function (e) {
        if (e.target === current && Date.now() - lastSync > 10000) syncLockScreen();
      }, true);

      function applyAppState(isBackground) {
        var now = Date.now();
        var wasBackground = background;
        background = isBackground;
        resumeUntil = background ? now + 3000 : 0;
        if (background && !wasBackground) {
          useFallbacks(true);
          // The system pause can land just before the app is told it went to the background.
          recent.forEach(function (r) { if (now - r.t < 1500 && r.m.paused) resume(r.m); });
          if (current && !current.paused && !current.ended) {
            startKeepAlive();
            syncLockScreen();
          }
          moveFramesToTimers();
        } else if (!background && wasBackground) {
          stopKeepAlive();
          useFallbacks(false);
          // Back on screen the media drives the lock screen itself again.
          if (ownPosition) {
            ownPosition = false;
            try { setPositionState.call(mediaSession); } catch (e) {}
          }
        }
        recent = [];
        // Players inside frames (embedded videos) get the news too.
        for (var i = 0; i < window.frames.length; i++) {
          try { window.frames[i].postMessage({ __shieldAppState: background }, '*'); } catch (e) {}
        }
      }
      window.addEventListener('message', function (e) {
        if (e.source === window.parent && window.parent !== window && e.data && typeof e.data.__shieldAppState === 'boolean') {
          applyAppState(e.data.__shieldAppState);
        }
      });
      // The sleep timer's pause: the user's, never undone.
      try {
        Object.defineProperty(window, '__stillwebUserPause', {
          value: function () {
            userPausedAt = Date.now();
            stopKeepAlive();
            try { if (current) current.pause(); } catch (e) {}
          }
        });
      } catch (e) {}
      try {
        Object.defineProperty(window, '__shieldAppState', {
          value: function (isBackground) { applyAppState(!!isBackground); }
        });
      } catch (e) {}

      if (window === window.top && /(^|\\.)youtube\\.com$/.test(location.hostname)) {
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

  override func layoutSubviews() {
    super.layoutSubviews()
    webView?.frame = bounds
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
        if let url = initialUrl { navigate(url) }
      }
    }
    guard let webView else { return }
    // Props arrive with every re-render; only real changes reach the page (a zoom change
    // relayouts it).
    let zoom = CGFloat(textZoom) / 100
    if webView.pageZoom != zoom { webView.pageZoom = zoom }
    // Lets pages that support prefers-color-scheme pick their dark theme.
    let style: UIUserInterfaceStyle = forceDark ? .dark : .unspecified
    if webView.overrideUserInterfaceStyle != style { webView.overrideUserInterfaceStyle = style }
    // Only one scroll view may answer the status bar tap.
    if webView.scrollView.scrollsToTop != active { webView.scrollView.scrollsToTop = active }
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

    install(WKWebView(frame: bounds, configuration: config))
    applyShields(for: nil)
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
    wv.frame = bounds
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
      wv.observe(\.estimatedProgress) { [weak self] v, _ in
        // WebKit reports tiny steps many times a second; the bar only needs visible ones.
        guard let self else { return }
        let progress = v.estimatedProgress
        guard progress >= 1 || progress < self.sentProgress || progress - self.sentProgress >= 0.05 else { return }
        self.sentProgress = progress
        self.onLoadProgress(["progress": progress])
      },
    ]

    // Tells the page when the app leaves or returns to the screen (background play).
    let center = NotificationCenter.default
    appObservers = [
      center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
        self?.sendAppState(background: true)
      },
      center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
        self?.sendAppState(background: false)
      },
    ]
  }

  private func sendAppState(background: Bool) {
    guard ShieldEngine.shared.backgroundPlay else { return }
    webView?.evaluateJavaScript("window.__shieldAppState && window.__shieldAppState(\(background))")
  }

  // MARK: - Commands

  private var pendingNavigation: String?

  func navigate(_ string: String) {
    guard let webView else {
      initialUrl = string
      return
    }
    // Don't let the first page load unfiltered while rule lists are still compiling.
    let engine = ShieldEngine.shared
    if !engine.isReady && engine.lastError == nil {
      let alreadyWaiting = pendingNavigation != nil
      pendingNavigation = string
      if !alreadyWaiting {
        engine.whenReady { [weak self] in
          guard let self, let next = self.pendingNavigation else { return }
          self.pendingNavigation = nil
          self.navigate(next)
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

  func goBack() { webView?.goBack() }
  func goForward() { webView?.goForward() }
  func stopLoading() { webView?.stopLoading() }
  func clearHistory() { /* WKWebView has no API to clear its back-forward list. */ }

  func reload() {
    // Force rules and scripts to be reapplied (shield settings may have changed).
    (webView?.configuration.userContentController as? ShieldContentController)?.appliedGeneration = -1
    applyShields(for: webView?.url)
    webView?.reload()
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

    if host != controller.appliedHost || controller.appliedGeneration != engine.generation {
      controller.removeAllUserScripts()
      controller.addUserScript(Self.statsScript)
      controller.addUserScript(Self.touchScript)
      controller.addUserScript(Self.privacyScript)
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
    }
    controller.appliedHost = host
    controller.appliedGeneration = engine.generation
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
    if UIApplication.shared.applicationState == .background { sendAppState(background: true) }
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    if webView.url == pendingUpgradeURL { pendingUpgradeURL = nil }
    onLoadEnd(["url": webView.url?.absoluteString ?? ""])
    emitNavigationState()
  }

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

  /// The page's process crashed or was ended to free memory. Reload it, unless it keeps
  /// crashing: after a third time within a minute the error page is shown instead.
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    let now = Date()
    terminations = terminations.filter { now.timeIntervalSince($0) < 60 } + [now]
    if terminations.count >= 3 {
      terminations.removeAll()
      webView.scrollView.refreshControl?.endRefreshing()
      onLoadError(["url": webView.url?.absoluteString ?? initialUrl ?? "", "code": -10001, "description": "PAGE_CRASHED"])
    } else {
      webView.reload()
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
    let popup = WKWebView(frame: .zero, configuration: configuration)
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
  /// disk, and the page is sent as the referrer like the browser itself would.
  private func loadImage(_ url: URL, completion: @escaping (UIImage?) -> Void) {
    if url.scheme?.lowercased() == "data" {
      return completion((try? Data(contentsOf: url)).flatMap(UIImage.init(data:)))
    }
    var request = URLRequest(url: url)
    if let page = webView?.url?.absoluteString { request.setValue(page, forHTTPHeaderField: "Referer") }
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
    let maxY = scrollView.contentSize.height - scrollView.bounds.height
    if y <= 0 || maxY < 120 {
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
