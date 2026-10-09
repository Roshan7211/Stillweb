import UIKit
import WebKit

// Runs the app's real ShieldWebView and ShieldEngine in an iOS simulator the way the app does:
// the engine starts, a web view is created with its first address, and the page is checked for
// what got through; then the user's reload, and the same check again. The point is the
// difference between the two, on the WebKit that iPhones actually have.
//
// Arguments: <address> [restored] [via-link | via-bar] [once]
//   via-link: a page of another site is opened first and sends the tab to the address by script
//   via-bar:  another site first, then the address as if typed into the address bar
let startedAt = Date()
func log(_ s: String) { print(String(format: "%6.1fs  ", Date().timeIntervalSince(startedAt)) + s); fflush(stdout) }
let arguments = Array(CommandLine.arguments.dropFirst())
let target = arguments.first ?? "https://youtube.com/"
let restored = arguments.contains("restored")
let viaLink = arguments.contains("via-link")
let viaBar = arguments.contains("via-bar")
let once = arguments.contains("once")
// bars: the page is under the app's bars as in the app (edge to edge), and they shrink and come
// back as they do when the user scrolls. open-video: the first video of a list is opened first.
let bars = arguments.contains("bars")
let openVideo = arguments.contains("open-video")
let barsShown = UIEdgeInsets(top: 0, left: 0, bottom: 100, right: 0)
let barsShrunk = UIEdgeInsets(top: 0, left: 0, bottom: 22, right: 0)
let settle = 9.0

let probe = """
(function () {
  var own = location.hostname.split('.').slice(-2).join('.');
  var res = performance.getEntriesByType('resource');
  var third = {};
  res.forEach(function (e) {
    try { var h = new URL(e.name).hostname; if (h !== own && !h.endsWith('.' + own)) third[h] = 1; } catch (err) {}
  });
  function trapped(name) { var d = Object.getOwnPropertyDescriptor(window, name); return !!(d && (d.get || d.set)); }
  var pr = null; try { pr = window.ytInitialPlayerResponse; } catch (e) {}
  var adKeys = pr ? ['adPlacements', 'playerAds', 'adSlots', 'adBreakHeartbeatParams'].filter(function (k) { return pr[k] !== undefined; }) : null;
  var adSel = 'ytm-promoted-sparkles-web-renderer,ytm-companion-ad-renderer,ad-slot-renderer,ytm-promoted-video-renderer,ytm-companion-slot,ytm-statement-banner-renderer,ytm-brand-video-singleton-renderer,ytmusic-mealbar-promo-renderer,.ad-container';
  var ads = Array.prototype.filter.call(document.querySelectorAll(adSel), function (el) { return el.offsetHeight > 0; }).map(function (el) { return el.tagName.toLowerCase(); });
  var v = window.visualViewport, video = document.querySelector('video');
  return {
    url: location.href.slice(0, 100), set: window.__swSet || null,
    trap: trapped('ytInitialPlayerResponse') || trapped('playerResponse'),
    playerResponse: pr ? 'present' : 'none', adKeys: adKeys, adsShown: ads.slice(0, 10),
    adPlaying: !!document.querySelector('.ad-showing,.ad-interrupting'),
    third: Object.keys(third).slice(0, 40), resources: res.length,
    width: [innerWidth, document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0, v ? v.scale : null, v ? v.width : null],
    video: video ? { paused: video.paused, t: Math.round(video.currentTime * 10) / 10, ready: video.readyState, muted: video.muted } : null,
    quiet: window.__stillwebQuiet === true, appState: typeof window.__shieldAppState,
    requests: window.__requests || null,
    headings: Array.prototype.filter.call(document.querySelectorAll('a h3, a [role=heading]'), function (e) { return e.offsetParent !== null && e.getBoundingClientRect().height > 0; }).length,
    links: [document.querySelectorAll('a[href]').length, Array.prototype.filter.call(document.querySelectorAll('a[href]'), function (e) { return e.offsetParent !== null; }).length],
    text: (document.body && document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 160),
    images: [document.images.length, Array.prototype.filter.call(document.images, function (i) { return i.complete && i.naturalWidth === 0 && i.src; }).length],
    sections: document.querySelectorAll('ytm-item-section-renderer, ytm-slim-video-metadata-section-renderer, ytm-video-with-context-renderer').length,
    size: (function () {
      var d = document.documentElement, b = document.body, m = document.querySelector('meta[name=viewport]');
      function box(sel) { var e = document.querySelector(sel); if (!e) return null; var r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; }
      function font(sel) { var e = document.querySelector(sel); return e ? getComputedStyle(e).fontSize : null; }
      return {
        inner: [innerWidth, innerHeight], client: [d.clientWidth, d.clientHeight], scroll: [Math.round(scrollX), Math.round(scrollY)],
        visual: v ? [Math.round(v.width * 10) / 10, Math.round(v.height * 10) / 10, v.scale, v.offsetLeft, v.offsetTop] : null,
        viewport: m ? m.content : null, rootFont: getComputedStyle(d).fontSize,
        player: box('#player-container-id, #player, .html5-video-player'),
        below: box('ytm-slim-video-metadata-section-renderer, ytm-single-column-watch-next-results-renderer, ytm-item-section-renderer'),
        title: box('.slim-video-information-title, h2'), titleFont: font('.slim-video-information-title, h2'),
        item: box('ytm-video-with-context-renderer, ytm-media-item'), itemFont: font('ytm-video-with-context-renderer h3, ytm-media-item h3, h3')
      };
    })()
  };
})()
"""

final class Runner {
  static let shared = Runner()
  var view: ShieldWebView!
  var blocked = 0
  var stage = "first"
  var generation = 0
  var lastURL = ""

  func start(in root: UIViewController) {
    let webKit = Bundle(for: WKWebView.self).infoDictionary?["CFBundleVersion"] as? String ?? "?"
    log("iOS \(UIDevice.current.systemVersion), WebKit \(webKit), screen \(UIScreen.main.bounds.size)")
    ShieldEngine.shared.onEngineChanged = { _ in
      let engine = ShieldEngine.shared
      log("engine: ready=\(engine.isReady) version=\(engine.version ?? "?") error=\(engine.lastError ?? "none") lists=\(engine.ruleLists.map { $0.identifier ?? "" })")
    }
    ShieldEngine.shared.initialize()
    if arguments.contains("no-shields") { ShieldEngine.shared.setOptions(["enabled": false]) }
    // As in the app: the first tab's view is created while the engine may still be loading.
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { self.createView(in: root) }
    DispatchQueue.main.asyncAfter(deadline: .now() + 420) { log("timeout"); exit(3) }
  }

  func createView(in root: UIViewController) {
    let via = viaLink || viaBar
    let first = via ? "https://example.com/" : target
    if via { stage = "before" }
    log("creating the web view for \(first) (engine ready: \(ShieldEngine.shared.isReady))" + (restored ? ", as a restored tab" : ""))
    view = ShieldWebView(appContext: nil)
    view.frame = root.view.bounds
    view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    root.view.addSubview(view)
    view.onBlockedCountChange.handler = { [weak self] body in self?.blocked = (body["blocked"] as? Int) ?? 0 }
    view.onLoadStart.handler = { [weak self] body in
      self?.generation += 1
      log("page: load started " + ((body["url"] as? String) ?? ""))
    }
    view.onNavigationStateChange.handler = { [weak self] body in
      guard let self, let url = body["url"] as? String, url != self.lastURL else { return }
      self.lastURL = url
      let shown: String = url.isEmpty ? "(empty)" : String(url.prefix(110))
      let title: String = (body["title"] as? String) ?? ""
      log("page: address is now \(shown), title '\(title.prefix(40))'")
    }
    view.onLoadError.handler = { body in log("page: ERROR \(body)") }
    view.onLoadEnd.handler = { [weak self] _ in self?.loaded() }
    // The props the app sets, then what Expo calls after setting them.
    if bars { view.chromeInsets = barsShown }
    view.initialUrl = first
    view.restored = restored
    view.active = true
    view.applyProps()
  }

  /// A page finished: once nothing new has started for a while, it is looked at.
  func loaded() {
    generation += 1
    let mine = generation
    log("page: finished loading")
    DispatchQueue.main.asyncAfter(deadline: .now() + (stage == "before" ? 2 : settle)) {
      guard mine == self.generation else { return }
      self.check()
    }
  }

  var web: WKWebView? { view.subviews.compactMap { $0 as? WKWebView }.first }

  /// What the app shows and what the page got, under `name`; then `next`.
  func report(_ name: String, then next: @escaping () -> Void) {
    view.evaluate(probe) { result in
      let info = self.view.layoutInfo()
      log("[\(name)] blocked count shown by the app: \(self.blocked)")
      log("[\(name)] app: scripts=\(info["scripts"] ?? "?") builtFor=\(info["scriptsFor"] ?? "?") attached=\(info["attached"] ?? "?") scriptsInPage=\(info["scriptsInPage"] ?? "?") repairs=\(info["repairs"] ?? "?") quiet=\(info["quiet"] ?? "?")")
      log("[\(name)] view: zoom=\(info["zoom"] ?? "?") minZoom=\(info["minZoom"] ?? "?") content=\(info["content"] ?? "?") webView=\(info["webView"] ?? "?")")
      log("[\(name)] insets: content=\(info["inset"] ?? "?") obscured=\(info["obscured"] ?? "?") offset=\(info["offset"] ?? "?")")
      log("[\(name)] page: \(result ?? "nil")")
      log("SHOT \(name)")
      DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: next)
    }
  }

  func userReload() {
    stage = "reload"
    log("--- the user's reload")
    view.reload()
  }

  func check() {
    switch stage {
    case "before":
      stage = "first"
      if viaBar {
        log("--- the address typed into the address bar: \(target)")
        view.navigate(target)
      } else {
        log("--- the page sends the tab to \(target)")
        view.evaluate("location.href = '\(target)'; 1") { _ in }
      }
    case "first":
      report("first") {
        if bars { return self.barsFlow() }
        if arguments.contains("kill") { self.endProcess() } else if once { log("done"); exit(0) } else { self.userReload() }
      }
    case "reopened":
      report("reopened") {
        // The first touch on a page the app loaded again by itself: the page tells the app.
        log("--- the first touch on the page (as the page reports it to the app)")
        self.web?.evaluateJavaScript("window.webkit.messageHandlers.shieldGesture.postMessage(1); 1", in: nil, in: .defaultClient) { _ in }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
          self.report("touched") { self.userReload() }
        }
      }
    case "busy":
      break
    default:
      report("reload") { log("done"); exit(0) }
    }
  }

  func setBars(collapsed: Bool) {
    view.chromeInsets = collapsed ? barsShrunk : barsShown
    view.syncChrome(collapsed: collapsed)
    view.applyProps()
  }

  func scroll(to y: CGFloat) {
    guard let scroll = web?.scrollView else { return }
    scroll.setContentOffset(CGPoint(x: 0, y: y - scroll.adjustedContentInset.top), animated: false)
  }

  /// What happens to the page while it is used: a video is opened from a list, the page is
  /// scrolled (the bars shrink), scrolled back (they return); then the user's reload.
  func barsFlow() {
    stage = "busy"
    var steps: [(name: String, wait: Double, action: () -> Void)] = []
    if openVideo {
      steps.append(("video", 9, {
        // What the page's own requests to the site return from here on (as the page gets them).
        let watch = "window.__requests = []; var f = window.fetch; window.fetch = function (input) { var u = String(input && input.url || input); var p = f.apply(this, arguments); if (u.indexOf('/youtubei/') >= 0) { p.then(function (r) { r.clone().text().then(function (t) { var keys = '?'; try { keys = Object.keys(JSON.parse(t)).slice(0, 8).join(','); } catch (e) { keys = 'NOT JSON: ' + t.slice(0, 60); } window.__requests.push(u.split('/youtubei/')[1].split('?')[0] + ' ' + r.status + ' ' + t.length + 'b [' + keys + ']'); }); }, function (e) { window.__requests.push(u.split('/youtubei/')[1].split('?')[0] + ' FAILED ' + e); }); } return p; }; 1"
        self.view.evaluate(watch) { _ in }
        let click = #"var a = document.querySelector('ytm-video-with-context-renderer a[href^="/watch"], a[href^="/watch"]'); if (a) a.click(); a ? a.getAttribute('href') : null"#
        self.view.evaluate(click) { result in log("--- the first video of the list is opened: \(result ?? "nil")") }
      }))
    }
    steps.append(("scrolled", 4, { log("--- scrolled down: the bars shrink"); self.scroll(to: 500); self.setBars(collapsed: true) }))
    steps.append(("bars-back", 4, { log("--- the bars come back"); self.setBars(collapsed: false) }))
    steps.append(("shrunk-again", 4, { log("--- and shrink again"); self.setBars(collapsed: true) }))
    steps.append(("top", 4, { log("--- back at the top, bars shown"); self.scroll(to: 0); self.setBars(collapsed: false) }))
    func next() {
      if arguments.contains("short"), steps.count == 4 { log("done"); exit(0) }
      guard !steps.isEmpty else { return self.userReload() }
      let step = steps.removeFirst()
      step.action()
      DispatchQueue.main.asyncAfter(deadline: .now() + step.wait) { self.report(step.name, then: next) }
    }
    next()
  }

  /// What iOS does to tabs in the background: the page's process ends while the tab is hidden.
  /// The tab must keep its address, and show the same page again when it is opened.
  func endProcess() {
    stage = "reopened"
    view.active = false
    view.applyProps()
    let before = (web?.value(forKey: "_webProcessIdentifier") as? NSNumber)?.int32Value ?? 0
    log("--- the hidden tab's page process (\(before)) is ended")
    kill(before, SIGKILL)
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
      let now = (self.web?.value(forKey: "_webProcessIdentifier") as? NSNumber)?.int32Value ?? 0
      if now == before {
        log("(it is still there: ended through WebKit instead)")
        _ = self.web?.perform(NSSelectorFromString("_killWebContentProcess"))
      }
      DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
        let shown: String = self.lastURL.isEmpty ? "(empty)" : self.lastURL
        log("the app's address for the tab: \(shown); the web view's own: \(self.web?.url?.absoluteString ?? "none")")
        log("--- the tab is opened again")
        self.view.active = true
        self.view.applyProps()
      }
    }
  }
}

@objc(SceneDelegate)
final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
    guard let windowScene = scene as? UIWindowScene else { return }
    let window = UIWindow(windowScene: windowScene)
    let root = UIViewController()
    root.view.backgroundColor = .white
    window.rootViewController = root
    window.makeKeyAndVisible()
    self.window = window
    Runner.shared.start(in: root)
  }
}

@objc(AppDelegate)
final class AppDelegate: UIResponder, UIApplicationDelegate {
  func application(_ application: UIApplication, configurationForConnecting session: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
    let configuration = UISceneConfiguration(name: "Default", sessionRole: session.role)
    configuration.delegateClass = SceneDelegate.self
    return configuration
  }
}

UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(AppDelegate.self))
