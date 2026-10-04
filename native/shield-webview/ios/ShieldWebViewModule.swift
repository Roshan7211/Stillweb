import ExpoModulesCore
import UIKit

public class ShieldWebViewModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ShieldWebView")

    View(ShieldWebView.self) {
      Events(
        "onLoadStart",
        "onLoadEnd",
        "onLoadProgress",
        "onNavigationStateChange",
        "onBlockedCountChange",
        "onOpenWindow",
        "onPopupBlocked",
        "onDownloadRequest",
        "onLoadError",
        "onExternalLink",
        "onContextMenu",
        "onFileChooser",
        "onFullscreenChange",
        "onFindResult",
        "onCloseRequest",
        "onLinkAction",
        "onChromeChange"
      )

      Prop("initialUrl") { (view: ShieldWebView, url: String?) in view.initialUrl = url }
      Prop("incognito") { (view: ShieldWebView, value: Bool?) in view.incognito = value ?? false }
      Prop("profileId") { (view: ShieldWebView, value: String?) in view.profileId = value }
      Prop("chromeInsets") { (view: ShieldWebView, value: [String: Double]?) in
        view.chromeInsets = value.map {
          UIEdgeInsets(top: CGFloat($0["top"] ?? 0), left: 0, bottom: CGFloat($0["bottom"] ?? 0), right: 0)
        }
      }
      Prop("forceDark") { (view: ShieldWebView, value: Bool?) in view.forceDark = value ?? false }
      Prop("textZoom") { (view: ShieldWebView, value: Int?) in view.textZoom = value ?? 100 }
      Prop("active") { (view: ShieldWebView, value: Bool?) in view.active = value ?? true }
      Prop("popupId") { (view: ShieldWebView, value: String?) in view.popupId = value }
      Prop("chromeCollapsed") { (view: ShieldWebView, value: Bool?) in view.syncChrome(collapsed: value ?? false) }

      OnViewDidUpdateProps { (view: ShieldWebView) in view.applyProps() }

      AsyncFunction("loadUrl") { (view: ShieldWebView, url: String) in view.navigate(url) }
      AsyncFunction("goBack") { (view: ShieldWebView) in view.goBack() }
      AsyncFunction("goForward") { (view: ShieldWebView) in view.goForward() }
      AsyncFunction("reload") { (view: ShieldWebView) in view.reload() }
      AsyncFunction("stopLoading") { (view: ShieldWebView) in view.stopLoading() }
      AsyncFunction("clearHistory") { (view: ShieldWebView) in view.clearHistory() }
      AsyncFunction("findInPage") { (view: ShieldWebView, query: String) in view.findInPage(query) }
      AsyncFunction("findNext") { (view: ShieldWebView, forward: Bool) in view.findNext(forward: forward) }
      AsyncFunction("clearFind") { (view: ShieldWebView) in view.clearFind() }
      AsyncFunction("showFindNavigator") { (view: ShieldWebView) -> Bool in view.showFindNavigator() }.runOnQueue(.main)
      AsyncFunction("captureThumbnail") { (view: ShieldWebView, key: String, promise: Promise) in
        view.captureThumbnail(key: key) { promise.resolve($0) }
      }
      // WKWebView manages element fullscreen itself (the system shows its own close button).
      AsyncFunction("exitFullscreen") { (_: ShieldWebView) -> Bool in false }
      // WKWebView presents its own file picker; nothing to resolve.
      AsyncFunction("resolveFileChooser") { (_: ShieldWebView, _: [String]?) in }
      AsyncFunction("evaluateJavaScript") { (view: ShieldWebView, script: String, promise: Promise) in
        view.evaluate(script) { promise.resolve($0) }
      }
    }
  }
}
