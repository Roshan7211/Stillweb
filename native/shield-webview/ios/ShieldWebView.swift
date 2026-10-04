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
  var forceDark = false
  var textZoom = 100
  /// The tab on screen: only it may show page dialogs or scroll to top from the status bar.
  var active = true
  /// Adopts the web view created for a page's window.open instead of making a new one.
  var popupId: String?

  private var webView: WKWebView?
  private var observations: [NSKeyValueObservation] = []
  private var appObservers: [NSObjectProtocol] = []
  private var shieldsActive = true
  private var countedHost: String?
  private var blockedOnPage = 0
  private var pendingUpgradeURL: URL?
  private var downloadProgress: [ObjectIdentifier: NSKeyValueObservation] = [:]
  private var downloadPaths: [ObjectIdentifier: String] = [:]
  private static var httpOnlyHosts = Set<String>()

  /// Web views WebKit asked for when a page opened a window, kept until the app shows them
  /// in a new tab. Returning a real web view keeps `window.opener`, which sign-in and
  /// payment pop-ups need to report back to the page that opened them.
  private static var pendingPopups: [String: WKWebView] = [:]

  /// Counts resource loads that fail (content-blocked requests surface as load errors).
  /// WebKit doesn't report blocked requests, so the iOS counter is an estimate.
  private static let statsScript = WKUserScript(
    source: """
    (function () {
      var pending = 0, timer = 0;
      var tags = /^(SCRIPT|IMG|IFRAME|LINK|VIDEO|AUDIO|SOURCE|EMBED|OBJECT)$/;
      function flush() {
        timer = 0;
        if (pending) { window.webkit.messageHandlers.shieldStats.postMessage(pending); pending = 0; }
      }
      window.addEventListener('error', function (e) {
        var el = e.target;
        if (el && el !== window && el.tagName && tags.test(el.tagName)) {
          pending++;
          if (!timer) timer = setTimeout(flush, 300);
        }
      }, true);
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
  /// nothing plays; with `__shieldAppState`, called by the app, the script plays again what
  /// the system paused and bridges the gap to the next video of a playlist with silence.
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

      // In the background iOS pauses video with sound, and suspends the page as soon as
      // nothing plays, so the next video of a playlist never starts. The app calls
      // __shieldAppState(true/false) when it leaves / returns to the screen.
      var background = false;
      var resumeUntil = 0;
      var recent = [];
      var userPausedAt = 0;
      function resume(m) {
        try { var r = m.play(); if (r && r.catch) r.catch(function () {}); } catch (e) {}
      }

      // Pauses from the lock screen or Control Center are the user's: never undone.
      try {
        var setActionHandler = MediaSession.prototype.setActionHandler;
        MediaSession.prototype.setActionHandler = function (action, handler) {
          if ((action === 'pause' || action === 'stop') && typeof handler === 'function') {
            var original = handler;
            handler = function () {
              userPausedAt = Date.now();
              stopKeepAlive();
              return original.apply(this, arguments);
            };
          }
          return setActionHandler.call(this, action, handler);
        };
      } catch (e) {}

      // Silence that keeps the page running between one video and the next.
      var keepAlive = null;
      var keepAliveTimer = 0;
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
        try {
          if (!keepAlive) {
            keepAlive = new Audio(silentWav());
            keepAlive.loop = true;
          }
          resume(keepAlive);
          clearTimeout(keepAliveTimer);
          // Nothing followed (end of a playlist, autoplay off): let the page rest.
          keepAliveTimer = setTimeout(stopKeepAlive, 60000);
        } catch (e) {}
      }
      function stopKeepAlive() {
        clearTimeout(keepAliveTimer);
        if (keepAlive && !keepAlive.paused) keepAlive.pause();
      }

      // Hidden pages get no animation frames on iOS; players that wait for one to load the
      // next video would stall. While in the background, frames come from a slow timer.
      try {
        var raf = window.requestAnimationFrame.bind(window);
        var cancelRaf = window.cancelAnimationFrame.bind(window);
        window.requestAnimationFrame = function (callback) {
          if (!background) return raf(callback);
          return -setTimeout(function () { callback(performance.now()); }, 100);
        };
        window.cancelAnimationFrame = function (id) {
          if (id < 0) clearTimeout(-id); else cancelRaf(id);
        };
      } catch (e) {}

      document.addEventListener('pause', function (e) {
        var m = e.target;
        if (!m || typeof m.play !== 'function' || m.ended) return;
        if (Date.now() - userPausedAt < 1500) return;
        if (Date.now() < resumeUntil) return resume(m);
        recent.push({ m: m, t: Date.now() });
        if (recent.length > 4) recent.shift();
      }, true);
      document.addEventListener('playing', function () {
        stopKeepAlive();
        // A video started in the background can be stopped by the system right away.
        if (background) resumeUntil = Date.now() + 2000;
      }, true);
      document.addEventListener('ended', function () {
        if (background) startKeepAlive();
      }, true);

      try {
        Object.defineProperty(window, '__shieldAppState', {
          value: function (isBackground) {
            var now = Date.now();
            background = !!isBackground;
            resumeUntil = background ? now + 3000 : 0;
            if (background) {
              // The system pause can land just before the app is told it went to the background.
              recent.forEach(function (r) { if (now - r.t < 1500 && r.m.paused) resume(r.m); });
            } else {
              stopKeepAlive();
            }
            recent = [];
          }
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
        applyShields(for: popup.url)
        emitNavigationState()
      } else {
        createWebView()
        if let url = initialUrl { navigate(url) }
      }
    }
    webView?.pageZoom = CGFloat(textZoom) / 100
    // Lets pages that support prefers-color-scheme pick their dark theme.
    webView?.overrideUserInterfaceStyle = forceDark ? .dark : .unspecified
    // Only one scroll view may answer the status bar tap.
    webView?.scrollView.scrollsToTop = active
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

  private func createWebView() {
    let config = WKWebViewConfiguration()
    // Private tabs share one in-memory jar (cleared when the last one closes).
    config.websiteDataStore = incognito ? ShieldEngine.shared.privateDataStore() : .default()
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

    install(WKWebView(frame: bounds, configuration: config))
    applyShields(for: nil)
  }

  /// Hooks a web view (new, or a page's pop-up) up to this view.
  private func install(_ wv: WKWebView) {
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
        self?.onLoadProgress(["progress": v.estimatedProgress])
      },
    ]

    // Tells the page when the app leaves or returns to the screen (background play).
    let center = NotificationCenter.default
    let notify: (Bool) -> Void = { [weak self] background in
      guard ShieldEngine.shared.backgroundPlay else { return }
      self?.webView?.evaluateJavaScript("window.__shieldAppState && window.__shieldAppState(\(background))")
    }
    appObservers = [
      center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in notify(true) },
      center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { _ in notify(false) },
    ]
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
      guard let data = image?.jpegData(compressionQuality: 0.7) else { return completion(nil) }
      let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("thumbs", isDirectory: true)
      try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      let safe = key.map { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" ? $0 : "_" }
      let file = dir.appendingPathComponent(String(safe) + ".jpg")
      do {
        try data.write(to: file, options: .atomic)
        completion(file.absoluteString)
      } catch {
        completion(nil)
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
        controller.rulesAttached = !engine.ruleLists.isEmpty
      }
    } else if controller.rulesAttached {
      controller.removeAllContentRuleLists()
      controller.rulesAttached = false
    }

    if host != controller.appliedHost || controller.appliedGeneration != engine.generation {
      controller.removeAllUserScripts()
      controller.addUserScript(Self.statsScript)
      controller.addUserScript(Self.privacyScript)
      if engine.backgroundPlay { controller.addUserScript(Self.backgroundPlayScript) }
      if active, let host, let source = engine.scriptletSource(forHost: host) {
        controller.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: false, in: .page))
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

  private func countBlocked(_ n: Int = 1) {
    blockedOnPage += n
    ShieldEngine.shared.recordBlocked(n)
    emitBlocked()
  }

  private func emitBlocked() {
    onBlockedCountChange(["blocked": blockedOnPage, "totalBlocked": ShieldEngine.shared.totalBlocked])
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
    if message.name == "shieldStats", shieldsActive, let n = message.body as? Int, n > 0 {
      countBlocked(n)
    }
  }

  // MARK: - WKNavigationDelegate

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
        countBlocked()
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

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    webView.reload()
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

  // Long-press on a link: Safari's menu, with the app opening new tabs.

  func webView(
    _ webView: WKWebView,
    contextMenuConfigurationForElement elementInfo: WKContextMenuElementInfo,
    completionHandler: @escaping (UIContextMenuConfiguration?) -> Void
  ) {
    guard let url = elementInfo.linkURL else { return completionHandler(nil) }
    let link = url.absoluteString
    let isWeb = ["http", "https"].contains(url.scheme?.lowercased() ?? "")
    let configuration = UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
      var items: [UIMenuElement] = []
      if isWeb {
        items.append(UIAction(title: self?.incognito == true ? "Open in New Private Tab" : "Open in New Tab",
                              image: UIImage(systemName: "plus.square.on.square")) { _ in
          self?.onLinkAction(["action": "open", "url": link])
        })
        if self?.incognito != true {
          items.append(UIAction(title: "Open in Private Tab", image: UIImage(systemName: "hand.raised")) { _ in
            self?.onLinkAction(["action": "openPrivate", "url": link])
          })
        }
        items.append(UIAction(title: "Download Linked File", image: UIImage(systemName: "arrow.down.circle")) { _ in
          self?.webView?.startDownload(using: URLRequest(url: url)) { download in
            download.delegate = self
          }
        })
      }
      items.append(UIAction(title: "Copy Link", image: UIImage(systemName: "doc.on.doc")) { _ in
        UIPasteboard.general.url = url
      })
      items.append(UIAction(title: "Share…", image: UIImage(systemName: "square.and.arrow.up")) { _ in
        self?.present(UIActivityViewController(activityItems: [url], applicationActivities: nil))
      })
      return UIMenu(title: link, children: items)
    }
    completionHandler(configuration)
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
    let dir = fm.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("Downloads", isDirectory: true)
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
