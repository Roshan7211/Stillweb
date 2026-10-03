package expo.modules.shieldwebview

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ShieldWebViewModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ShieldWebView")

    View(ShieldWebView::class) {
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
        "onCloseRequest"
      )

      Prop("initialUrl") { view: ShieldWebView, url: String? -> view.initialUrl = url }
      Prop("incognito") { view: ShieldWebView, value: Boolean? -> view.incognito = value ?: false }
      Prop("forceDark") { view: ShieldWebView, value: Boolean? -> view.forceDark = value ?: false }
      Prop("textZoom") { view: ShieldWebView, value: Int? -> view.textZoom = value ?: 100 }

      OnViewDidUpdateProps { view: ShieldWebView -> view.applyProps() }
      OnViewDestroys { view: ShieldWebView -> view.destroy() }

      AsyncFunction("loadUrl") { view: ShieldWebView, url: String -> view.navigate(url) }
      AsyncFunction("goBack") { view: ShieldWebView -> view.goBack() }
      AsyncFunction("goForward") { view: ShieldWebView -> view.goForward() }
      AsyncFunction("reload") { view: ShieldWebView -> view.reload() }
      AsyncFunction("stopLoading") { view: ShieldWebView -> view.stopLoading() }
      AsyncFunction("clearHistory") { view: ShieldWebView -> view.clearHistory() }
      AsyncFunction("findInPage") { view: ShieldWebView, query: String -> view.findInPage(query) }
      AsyncFunction("findNext") { view: ShieldWebView, forward: Boolean -> view.findNext(forward) }
      AsyncFunction("clearFind") { view: ShieldWebView -> view.clearFind() }
      AsyncFunction("captureThumbnail") { view: ShieldWebView, key: String -> view.captureThumbnail(key) }
      AsyncFunction("exitFullscreen") { view: ShieldWebView -> view.exitFullscreenIfShowing() }
      AsyncFunction("resolveFileChooser") { view: ShieldWebView, uris: List<String>? -> view.resolveFileChooser(uris) }
      AsyncFunction("evaluateJavaScript") { view: ShieldWebView, script: String, promise: Promise ->
        view.evaluate(script) { result -> promise.resolve(result) }
      }
    }
  }
}
