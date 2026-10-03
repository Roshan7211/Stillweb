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

/// WKWebView with EasyList/EasyPrivacy-derived WKContentRuleLists attached and per-host
/// scriptlets injected at document start.
final class ShieldWebView: ExpoView, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKDownloadDelegate {
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
  // Android only: WKWebView shows its own link menu and file picker.
  let onContextMenu = EventDispatcher()
  let onFileChooser = EventDispatcher()
  let onFullscreenChange = EventDispatcher()
  let onFindResult = EventDispatcher()
  let onCloseRequest = EventDispatcher()

  var initialUrl: String?
  var incognito = false
  var forceDark = false
  var textZoom = 100

  private var webView: WKWebView?
  private var observations: [NSKeyValueObservation] = []
  private var shieldsActive = true
  private var rulesAttached = false
  private var appliedGeneration = -1
  private var appliedHost: String?
  private var blockedOnPage = 0
  private var pendingUpgradeURL: URL?
  private var downloads: [ObjectIdentifier: URL] = [:]
  private static var httpOnlyHosts = Set<String>()

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
    webView?.configuration.userContentController.removeAllScriptMessageHandlers()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    webView?.frame = bounds
  }

  // MARK: - Props

  func applyProps() {
    if webView == nil {
      createWebView()
      if let url = initialUrl { navigate(url) }
    }
    webView?.pageZoom = CGFloat(textZoom) / 100
    // Lets pages that support prefers-color-scheme pick their dark theme.
    webView?.overrideUserInterfaceStyle = forceDark ? .dark : .unspecified
  }

  private func createWebView() {
    let config = WKWebViewConfiguration()
    config.websiteDataStore = incognito ? .nonPersistent() : .default()
    config.allowsInlineMediaPlayback = true
    config.mediaTypesRequiringUserActionForPlayback = .all
    config.preferences.javaScriptCanOpenWindowsAutomatically = false
    config.preferences.isElementFullscreenEnabled = true
    config.userContentController.add(WeakScriptHandler(self), contentWorld: .defaultClient, name: "shieldStats")

    let wv = WKWebView(frame: bounds, configuration: config)
    wv.navigationDelegate = self
    wv.uiDelegate = self
    wv.allowsBackForwardNavigationGestures = true
    wv.isOpaque = false
    wv.backgroundColor = .clear
    addSubview(wv)
    webView = wv

    let emit: (WKWebView) -> Void = { [weak self] _ in self?.emitNavigationState() }
    observations = [
      wv.observe(\.url) { v, _ in emit(v) },
      wv.observe(\.title) { v, _ in emit(v) },
      wv.observe(\.canGoBack) { v, _ in emit(v) },
      wv.observe(\.canGoForward) { v, _ in emit(v) },
      wv.observe(\.isLoading) { v, _ in emit(v) },
      wv.observe(\.estimatedProgress) { [weak self] v, _ in
        self?.onLoadProgress(["progress": v.estimatedProgress])
      },
    ]
    applyShields(for: nil)
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

  func goBack() { webView?.goBack() }
  func goForward() { webView?.goForward() }
  func stopLoading() { webView?.stopLoading() }
  func clearHistory() { /* WKWebView has no API to clear its back-forward list. */ }

  func reload() {
    appliedGeneration = -1 // force rules + scripts to be reapplied
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
    webView?.evaluateJavaScript("window.getSelection().removeAllRanges()")
  }

  // MARK: - Shields

  /// Attaches or detaches rule lists and installs the scriptlets for the page's host.
  /// Called before each main-frame navigation is allowed, so new documents pick them up.
  private func applyShields(for url: URL?) {
    guard let webView else { return }
    let engine = ShieldEngine.shared
    let host = url?.host?.lowercased()
    let active = engine.shieldsEnabled(forHost: host)
    let controller = webView.configuration.userContentController

    if active != shieldsActive || host != appliedHost {
      if blockedOnPage != 0 {
        blockedOnPage = 0
        emitBlocked()
      }
    }
    shieldsActive = active

    if active {
      if !rulesAttached || appliedGeneration != engine.generation {
        controller.removeAllContentRuleLists()
        engine.ruleLists.forEach(controller.add)
        rulesAttached = !engine.ruleLists.isEmpty
      }
    } else if rulesAttached {
      controller.removeAllContentRuleLists()
      rulesAttached = false
    }

    if host != appliedHost || appliedGeneration != engine.generation {
      controller.removeAllUserScripts()
      controller.addUserScript(Self.statsScript)
      controller.addUserScript(Self.privacyScript)
      if ShieldEngine.shared.backgroundPlay { controller.addUserScript(Self.backgroundPlayScript) }
      if active, let host, let source = engine.scriptletSource(forHost: host) {
        controller.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: false, in: .page))
      }
    }
    appliedHost = host
    appliedGeneration = engine.generation
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
    decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
  }

  func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
    download.delegate = self
  }

  func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
    download.delegate = self
  }

  func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
    onLoadStart(["url": webView.url?.absoluteString ?? ""])
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    if webView.url == pendingUpgradeURL { pendingUpgradeURL = nil }
    onLoadEnd(["url": webView.url?.absoluteString ?? ""])
    emitNavigationState()
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    let nsError = error as NSError
    if nsError.code == NSURLErrorCancelled { return }
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
    if let url = action.request.url, url.absoluteString != "about:blank", !url.absoluteString.isEmpty {
      onOpenWindow(["url": url.absoluteString, "incognito": incognito])
    } else if ShieldEngine.shared.blockPopups && shieldsActive {
      countBlocked()
      onPopupBlocked(["url": "", "kind": "popup"])
    }
    return nil
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
    var destination = dir.appendingPathComponent(suggestedFilename)
    var n = 1
    let base = destination.deletingPathExtension().lastPathComponent
    let ext = destination.pathExtension
    while fm.fileExists(atPath: destination.path) {
      destination = dir.appendingPathComponent(ext.isEmpty ? "\(base) (\(n))" : "\(base) (\(n)).\(ext)")
      n += 1
    }
    downloads[ObjectIdentifier(download)] = destination
    onDownloadRequest([
      "url": response.url?.absoluteString ?? "",
      "userAgent": "",
      "contentDisposition": "attachment; filename=\"\(destination.lastPathComponent)\"",
      "mimeType": response.mimeType ?? "",
      "contentLength": Double(response.expectedContentLength),
      "incognito": incognito,
      "handledNatively": true,
      "filePath": destination.path,
    ])
    completionHandler(destination)
  }

  func downloadDidFinish(_ download: WKDownload) {
    downloads.removeValue(forKey: ObjectIdentifier(download))
  }

  func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
    downloads.removeValue(forKey: ObjectIdentifier(download))
  }
}
