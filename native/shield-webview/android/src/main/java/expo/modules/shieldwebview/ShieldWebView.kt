package expo.modules.shieldwebview

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.net.Uri
import android.net.http.SslError
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.ProfileStore
import androidx.webkit.ScriptHandler
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * Stays "visible" to Chromium while it owns the media session, so audio keeps playing when
 * the app is in the background or the screen is off (Chromium pauses hidden pages' media).
 */
@SuppressLint("ViewConstructor")
internal class BrowserWebView(context: Context, private val keepVisible: () -> Boolean) : WebView(context) {
  override fun onWindowVisibilityChanged(visibility: Int) {
    if (visibility != View.VISIBLE && keepVisible()) {
      super.onWindowVisibilityChanged(View.VISIBLE)
      return
    }
    super.onWindowVisibilityChanged(visibility)
  }
}

/**
 * A WebView whose every subresource request is checked against adblock-rust in
 * shouldInterceptRequest, with cosmetic filters and scriptlets injected at document start.
 */
@SuppressLint("ViewConstructor", "SetJavaScriptEnabled")
class ShieldWebView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  companion object {
    const val PRIVATE_PROFILE = "private"
    private const val BRIDGE_NAME = "__shieldBridge"
    private const val MEDIA_BRIDGE_NAME = "__shieldMedia"
    private const val NOTIFICATION_PERMISSION_REQUEST = 0x5712
    private const val MAIN_FRAME_SCRIPT_WAIT_MS = 400L

    /** Hosts where an HTTPS upgrade failed; shared by all tabs for this process. */
    private val httpOnlyHosts: MutableSet<String> = Collections.synchronizedSet(mutableSetOf())

    val privateTabsIsolated: Boolean
      get() = WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)
  }

  private val onLoadStart by EventDispatcher()
  private val onLoadEnd by EventDispatcher()
  private val onLoadProgress by EventDispatcher()
  private val onNavigationStateChange by EventDispatcher()
  private val onBlockedCountChange by EventDispatcher()
  private val onOpenWindow by EventDispatcher()
  private val onPopupBlocked by EventDispatcher()
  private val onDownloadRequest by EventDispatcher()
  private val onLoadError by EventDispatcher()
  private val onExternalLink by EventDispatcher()
  private val onContextMenu by EventDispatcher()
  private val onFileChooser by EventDispatcher()
  private val onFullscreenChange by EventDispatcher()
  private val onFindResult by EventDispatcher()
  private val onCloseRequest by EventDispatcher()

  // ---- props (applied together in applyProps) ----
  var initialUrl: String? = null
  var incognito = false
  var forceDark = false
  var textZoom = 100

  private var webView: WebView? = null
  private val main = Handler(Looper.getMainLooper())

  // ---- page state, read from WebView IO threads ----
  @Volatile private var pageUrl = "about:blank"
  @Volatile private var shieldsActive = true
  private val blockedOnPage = AtomicInteger(0)
  /** Blocked request counts by host since the last event (for the privacy report). */
  private val blockedHosts = java.util.concurrent.ConcurrentHashMap<String, Int>()
  private val blockedEventQueued = AtomicBoolean(false)

  // ---- cosmetic scripts registered per hostname (main thread writes) ----
  private object NoScript
  private val hostScripts = ConcurrentHashMap<String, Any>()
  @Volatile private var scriptsGeneration = -1
  private var genericScript: ScriptHandler? = null
  private var privacyScript: ScriptHandler? = null

  // ---- main-thread state ----
  private var pendingUpgradeUrl: String? = null
  private var title = ""
  private var progress = 0
  private var loading = false
  private var fullscreenView: View? = null
  private var fullscreenCallback: WebChromeClient.CustomViewCallback? = null
  private var fileCallback: ValueCallback<Array<Uri>>? = null
  private var pendingNavigation: String? = null
  private var orientationBeforeFullscreen: Int? = null
  /** Site where the user started media; autoplay stays allowed there until leaving it. */
  @Volatile private var mediaAllowedHost: String? = null
  private var extraScripts = mutableListOf<ScriptHandler>()

  // ---------------------------------------------------------------------------
  // Props & lifecycle

  fun applyProps() {
    val wv = webView ?: createWebView().also { created ->
      webView = created
      initialUrl?.let { navigate(it) }
    }
    wv.settings.textZoom = textZoom
    if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
      WebSettingsCompat.setAlgorithmicDarkeningAllowed(wv.settings, forceDark)
    }
  }

  fun destroy() {
    MediaPlaybackController.onViewDestroyed(this)
    extraScripts.forEach { it.remove() }
    extraScripts.clear()
    exitFullscreen()
    resolveFileChooser(null)
    webView?.let { wv ->
      removeHostScripts()
      genericScript?.remove()
      privacyScript?.remove()
      wv.stopLoading()
      wv.webChromeClient = null
      removeView(wv)
      wv.destroy()
    }
    webView = null
  }

  private fun createWebView(): WebView {
    // An Activity context lets pages show alert()/confirm() dialogs and <select> pickers.
    val wv = BrowserWebView(appContext.currentActivity ?: context) {
      ShieldEngine.backgroundPlay && MediaPlaybackController.isSessionView(this)
    }
    // The profile has to be chosen before the WebView is used for anything else.
    if (incognito && privateTabsIsolated) {
      ProfileStore.getInstance().getOrCreateProfile(PRIVATE_PROFILE)
      WebViewCompat.setProfile(wv, PRIVATE_PROFILE)
    }
    wv.layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
    wv.setBackgroundColor(Color.TRANSPARENT)

    wv.settings.apply {
      javaScriptEnabled = true
      domStorageEnabled = true
      setSupportMultipleWindows(true)
      javaScriptCanOpenWindowsAutomatically = false
      mediaPlaybackRequiresUserGesture = true
      builtInZoomControls = true
      displayZoomControls = false
      loadWithOverviewMode = true
      useWideViewPort = true
      allowFileAccess = false
      allowContentAccess = false
      mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
      // Drop the "; wv" WebView marker so sites serve their normal mobile pages.
      userAgentString = userAgentString.replace("; wv", "").replace(Regex("Version/\\S+ "), "")
    }

    cookieManagerFor(wv).setAcceptThirdPartyCookies(wv, !ShieldEngine.blockThirdPartyCookies)

    wv.webViewClient = Client()
    wv.webChromeClient = Chrome()
    wv.setDownloadListener { url, userAgent, contentDisposition, mimeType, contentLength ->
      onDownloadRequest(
        mapOf(
          "url" to url,
          "userAgent" to userAgent.orEmpty(),
          "contentDisposition" to contentDisposition.orEmpty(),
          "mimeType" to mimeType.orEmpty(),
          "contentLength" to contentLength.toDouble(),
          "incognito" to incognito
        )
      )
    }

    wv.setOnLongClickListener { onLongPress(wv) }
    wv.setFindListener { active, count, done ->
      if (done) onFindResult(mapOf("active" to if (count > 0) active + 1 else 0, "count" to count))
    }
    if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
      privacyScript = WebViewCompat.addDocumentStartJavaScript(wv, CosmeticScripts.privacy(context), setOf("*"))
    }

    installGenericCosmetics(wv)
    installMediaBridge(wv)
    addView(wv)
    return wv
  }

  /** Background play: reports audible media to [MediaPlaybackController] and relays its commands. */
  private fun installMediaBridge(wv: WebView) {
    if (!ShieldEngine.backgroundPlay ||
      !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
      !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
    ) {
      return
    }
    WebViewCompat.addWebMessageListener(wv, MEDIA_BRIDGE_NAME, setOf("*")) { _, message, sourceOrigin, _, replyProxy ->
      val data = runCatching { JSONObject(message.data ?: "{}") }.getOrNull() ?: return@addWebMessageListener
      val playing = data.optBoolean("playing")
      if (playing) {
        requestNotificationPermissionOnce()
        // Media already started here (which needed a tap), so let the site continue on its own:
        // next track, autoplay of the next video, resuming after buffering, all without a tap.
        if (wv.settings.mediaPlaybackRequiresUserGesture) {
          wv.settings.mediaPlaybackRequiresUserGesture = false
          mediaAllowedHost = hostOf(pageUrl)
        }
      }
      MediaPlaybackController.onMediaState(this, replyProxy, data, title, sourceOrigin.host.orEmpty().removePrefix("www."))
    }
    extraScripts += WebViewCompat.addDocumentStartJavaScript(wv, CosmeticScripts.script(context, "background-play.js"), setOf("*"))
    extraScripts += WebViewCompat.addDocumentStartJavaScript(wv, CosmeticScripts.script(context, "media.js"), setOf("*"))
  }

  /** Android 13+: the playback notification needs permission; ask once, the first time media plays. */
  private fun requestNotificationPermissionOnce() {
    if (android.os.Build.VERSION.SDK_INT < 33) return
    val activity = activity() ?: return
    val permission = android.Manifest.permission.POST_NOTIFICATIONS
    if (androidx.core.content.ContextCompat.checkSelfPermission(activity, permission) ==
      android.content.pm.PackageManager.PERMISSION_GRANTED
    ) {
      return
    }
    val prefs = activity.getSharedPreferences("shield_engine", Context.MODE_PRIVATE)
    if (prefs.getBoolean("askedNotifications", false)) return
    prefs.edit().putBoolean("askedNotifications", true).apply()
    androidx.core.app.ActivityCompat.requestPermissions(activity, arrayOf(permission), NOTIFICATION_PERMISSION_REQUEST)
  }

  /** Long-press on a link or image: hand it to JS for the context menu. Text keeps native selection. */
  private fun onLongPress(wv: WebView): Boolean {
    val hit = wv.hitTestResult
    val extra = hit.extra
    // Inline data: images are not useful to open, share or download.
    val image = extra?.takeUnless { it.startsWith("data:") }.orEmpty()
    return when (hit.type) {
      WebView.HitTestResult.SRC_ANCHOR_TYPE -> {
        onContextMenu(mapOf("link" to extra.orEmpty(), "image" to ""))
        true
      }
      WebView.HitTestResult.IMAGE_TYPE -> {
        if (image.isEmpty()) return false
        onContextMenu(mapOf("link" to "", "image" to image))
        true
      }
      WebView.HitTestResult.SRC_IMAGE_ANCHOR_TYPE -> {
        val reply = Handler(Looper.getMainLooper()) { msg ->
          onContextMenu(mapOf("link" to (msg.data.getString("url") ?: ""), "image" to image))
          true
        }.obtainMessage()
        wv.requestFocusNodeHref(reply)
        true
      }
      else -> false
    }
  }

  /** Completes a pending <input type=file>; null means the user cancelled. */
  fun resolveFileChooser(uris: List<String>?) {
    fileCallback?.onReceiveValue(uris?.map { Uri.parse(it) }?.toTypedArray())
    fileCallback = null
  }

  private fun cookieManagerFor(wv: WebView): CookieManager =
    if (incognito && privateTabsIsolated) WebViewCompat.getProfile(wv).cookieManager else CookieManager.getInstance()

  // ---------------------------------------------------------------------------
  // Commands from JS (main thread)

  fun navigate(url: String) {
    val wv = webView ?: run { initialUrl = url; return }
    // Don't let the first page load unfiltered while the engine is still starting.
    if (!ShieldEngine.isReady && ShieldEngine.lastError == null) {
      val alreadyWaiting = pendingNavigation != null
      pendingNavigation = url
      if (!alreadyWaiting) {
        ShieldEngine.whenReady {
          val next = pendingNavigation
          pendingNavigation = null
          if (next != null && webView != null) navigate(next)
        }
      }
      return
    }
    val target = upgradeIfNeeded(url)
    beginMainFrame(target)
    registerHostScript(target)
    wv.loadUrl(target, mapOf("Sec-GPC" to "1"))
  }

  fun goBack() = webView?.takeIf { it.canGoBack() }?.goBack()
  fun goForward() = webView?.takeIf { it.canGoForward() }?.goForward()
  fun reload() = webView?.let {
    val url = it.url ?: pageUrl
    resetHostScriptsIfStale(force = true)
    pageUrl = "about:blank" // so the reload counts as a new page
    beginMainFrame(url)
    registerHostScript(url)
    it.reload()
  }
  fun stopLoading() = webView?.stopLoading()
  fun clearHistory() = webView?.clearHistory()

  fun evaluate(script: String, callback: (String?) -> Unit) {
    val wv = webView ?: return callback(null)
    wv.evaluateJavascript(script) { callback(it) }
  }

  /**
   * Draws the visible page into a small JPEG in the cache (for the tab switcher) and returns
   * its file:// URI, or null when there is nothing to draw.
   */
  fun captureThumbnail(key: String): String? {
    val wv = webView ?: return null
    if (wv.width == 0 || wv.height == 0) return null
    return try {
      val width = 360
      val scale = width.toFloat() / wv.width
      val bitmap = Bitmap.createBitmap(width, (wv.height * scale).toInt().coerceAtLeast(1), Bitmap.Config.RGB_565)
      val canvas = Canvas(bitmap)
      canvas.scale(scale, scale)
      canvas.translate(-wv.scrollX.toFloat(), -wv.scrollY.toFloat())
      wv.draw(canvas)
      val dir = File(context.cacheDir, "thumbs").apply { mkdirs() }
      val file = File(dir, key.replace(Regex("[^A-Za-z0-9_-]"), "_") + ".jpg")
      file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 70, it) }
      bitmap.recycle()
      Uri.fromFile(file).toString()
    } catch (t: Throwable) {
      null
    }
  }

  /** Leaves fullscreen video; returns whether it was showing. */
  fun exitFullscreenIfShowing(): Boolean {
    val showing = fullscreenView != null
    exitFullscreen()
    return showing
  }

  fun findInPage(query: String) {
    webView?.findAllAsync(query)
  }

  fun findNext(forward: Boolean) {
    webView?.findNext(forward)
  }

  fun clearFind() {
    webView?.clearMatches()
  }

  // ---------------------------------------------------------------------------
  // Shields helpers

  private fun debug(message: String) {
    if (ShieldEngine.debuggable) android.util.Log.d("ShieldNav", message)
  }

  private fun hostOf(url: String): String? = runCatching { Uri.parse(url).host?.lowercase() }.getOrNull()

  /** Called for every main-frame load (any thread): resets per-page state. */
  private fun beginMainFrame(url: String) {
    // Recompute every time: per-site settings may have changed since the last load.
    shieldsActive = ShieldEngine.shieldsEnabledFor(hostOf(url))
    // Leaving the site where media was started: other sites need a tap again to play sound.
    val allowed = mediaAllowedHost
    if (allowed != null && allowed != hostOf(url)) {
      mediaAllowedHost = null
      main.post { webView?.settings?.mediaPlaybackRequiresUserGesture = true }
    }
    if (url == pageUrl) return
    pageUrl = url
    if (blockedOnPage.getAndSet(0) != 0) queueBlockedEvent()
  }

  private fun countBlocked(url: String? = null) {
    blockedOnPage.incrementAndGet()
    url?.let(::hostOf)?.let { host -> blockedHosts.merge(host, 1, Int::plus) }
    ShieldEngine.recordBlocked()
    queueBlockedEvent()
  }

  /** Coalesces counter updates to at most one event per 250 ms. */
  private fun queueBlockedEvent() {
    if (!blockedEventQueued.compareAndSet(false, true)) return
    main.postDelayed({
      blockedEventQueued.set(false)
      val hosts = HashMap<String, Int>()
      for (host in blockedHosts.keys) blockedHosts.remove(host)?.let { hosts[host] = it }
      onBlockedCountChange(
        mapOf("blocked" to blockedOnPage.get(), "totalBlocked" to ShieldEngine.totalBlocked().toDouble(), "hosts" to hosts)
      )
    }, 250)
  }

  private fun upgradeIfNeeded(url: String): String {
    if (!ShieldEngine.httpsUpgrade || !url.startsWith("http://", ignoreCase = true)) return url
    val host = hostOf(url) ?: return url
    if (host in httpOnlyHosts || host == "localhost" || host.endsWith(".local") || host.matches(Regex("[\\d.]+"))) {
      return url
    }
    val upgraded = "https://" + url.substring("http://".length)
    pendingUpgradeUrl = upgraded
    return upgraded
  }

  private fun fallBackToHttp(failedUrl: String): Boolean {
    if (failedUrl != pendingUpgradeUrl) return false
    pendingUpgradeUrl = null
    hostOf(failedUrl)?.let { httpOnlyHosts.add(it) }
    val http = "http://" + failedUrl.substring("https://".length)
    webView?.loadUrl(http)
    return true
  }

  private fun resetHostScriptsIfStale(force: Boolean = false) {
    val gen = ShieldEngine.generation.get()
    if (force || gen != scriptsGeneration) {
      removeHostScripts()
      scriptsGeneration = gen
    }
  }

  private fun removeHostScripts() {
    for (value in hostScripts.values) (value as? ScriptHandler)?.remove()
    hostScripts.clear()
  }

  /**
   * Main thread. Registers this hostname's scriptlets + specific cosmetic rules as a
   * document-start script limited to that origin, so they run before page scripts.
   */
  private fun registerHostScript(url: String) {
    val wv = webView ?: return
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
    resetHostScriptsIfStale()
    val uri = runCatching { Uri.parse(url) }.getOrNull() ?: return
    val host = uri.host?.lowercase() ?: return
    if (uri.scheme != "http" && uri.scheme != "https") return
    if (hostScripts.containsKey(host)) return
    if (!ShieldEngine.isReady || !ShieldEngine.shieldsEnabledFor(host)) return

    val resources = ShieldEngine.cosmeticResources("https://$host/") ?: return
    val script = CosmeticScripts.forHost(context, resources, ShieldEngine.cosmeticFiltering)
    hostScripts[host] = if (script == null) {
      NoScript
    } else {
      WebViewCompat.addDocumentStartJavaScript(wv, script, setOf("https://$host", "http://$host"))
    }
  }

  /** IO thread: make sure the host script exists before the document starts parsing. */
  private fun ensureHostScriptFromIo(url: String, wait: Boolean) {
    val host = hostOf(url) ?: return
    if (scriptsGeneration == ShieldEngine.generation.get() && hostScripts.containsKey(host)) return
    val latch = CountDownLatch(1)
    main.post {
      try {
        registerHostScript(url)
      } finally {
        latch.countDown()
      }
    }
    if (wait) latch.await(MAIN_FRAME_SCRIPT_WAIT_MS, TimeUnit.MILLISECONDS)
  }

  /** Generic (class/id) hiding for all frames, answered by the engine over a message bridge. */
  private fun installGenericCosmetics(wv: WebView) {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
      !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
    ) {
      return
    }
    // Per-origin generichide/exception data; cleared when the engine changes.
    val exceptionCache = object : android.util.LruCache<String, Pair<Int, JSONArray?>>(64) {}

    WebViewCompat.addWebMessageListener(wv, BRIDGE_NAME, setOf("*")) { _, message, sourceOrigin, _, replyProxy ->
      val reply = try {
        val origin = sourceOrigin.toString()
        val host = sourceOrigin.host?.lowercase()
        val gen = ShieldEngine.generation.get()
        val cached = exceptionCache.get(origin)?.takeIf { it.first == gen }
        val exceptions = if (cached != null) {
          cached.second
        } else {
          val enabled = ShieldEngine.cosmeticFiltering && ShieldEngine.shieldsEnabledFor(host) &&
            ShieldEngine.shieldsEnabledFor(hostOf(pageUrl))
          val res = if (enabled) ShieldEngine.cosmeticResources("$origin/") else null
          // null exceptions = generic hiding disabled for this origin.
          val value = res?.takeUnless { it.optBoolean("generichide") }?.let { it.optJSONArray("exceptions") ?: JSONArray() }
          exceptionCache.put(origin, gen to value)
          value
        }
        if (exceptions == null) {
          "null"
        } else {
          val query = JSONObject(message.data ?: "{}")
          ShieldEngine.hiddenSelectors(
            query.optJSONArray("classes") ?: JSONArray(),
            query.optJSONArray("ids") ?: JSONArray(),
            exceptions
          )
        }
      } catch (t: Throwable) {
        "[]"
      }
      if (ShieldEngine.debuggable) android.util.Log.d("ShieldGeneric", "${sourceOrigin} -> ${reply.take(160)}")
      replyProxy.postMessage(reply)
    }
    genericScript = WebViewCompat.addDocumentStartJavaScript(wv, CosmeticScripts.generic(context), setOf("*"))
  }

  // ---------------------------------------------------------------------------
  // Navigation state

  private fun emitNavigationState() {
    val wv = webView ?: return
    onNavigationStateChange(
      mapOf(
        "url" to (wv.url ?: pageUrl),
        "title" to title,
        "canGoBack" to wv.canGoBack(),
        "canGoForward" to wv.canGoForward(),
        "loading" to loading,
        "progress" to progress / 100.0,
        "shieldsActive" to shieldsActive,
        "secure" to (wv.url ?: pageUrl).startsWith("https://")
      )
    )
  }

  private fun activity(): Activity? = appContext.currentActivity

  /** Fullscreen landscape videos rotate to landscape (portrait ones stay as they are), like Chrome. */
  private fun matchVideoOrientation() {
    // The page marks its fullscreen element just after the custom view appears, so wait a
    // moment; fall back to the video that is playing.
    val script = "(function(){var e=document.fullscreenElement||document.webkitFullscreenElement;" +
      "var v=e&&(e.tagName==='VIDEO'?e:e.querySelector('video'));" +
      "if(!v){v=Array.prototype.slice.call(document.querySelectorAll('video')).filter(function(x){return !x.paused})[0];}" +
      "return v&&v.videoWidth?v.videoWidth/v.videoHeight:0})()"
    main.postDelayed({ if (fullscreenView != null) evaluateVideoRatio(script) }, 300)
  }

  private fun evaluateVideoRatio(script: String) {
    webView?.evaluateJavascript(script) { result ->
      val ratio = result?.toDoubleOrNull() ?: 0.0
      val activity = activity() ?: return@evaluateJavascript
      if (fullscreenView == null || ratio <= 1.0) return@evaluateJavascript
      if (orientationBeforeFullscreen == null) orientationBeforeFullscreen = activity.requestedOrientation
      activity.requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
    }
  }

  private fun exitFullscreen() {
    val view = fullscreenView ?: return
    (view.parent as? ViewGroup)?.removeView(view)
    fullscreenView = null
    orientationBeforeFullscreen?.let { activity()?.requestedOrientation = it }
    orientationBeforeFullscreen = null
    onFullscreenChange(mapOf("fullscreen" to false))
    fullscreenCallback?.onCustomViewHidden()
    fullscreenCallback = null
    activity()?.window?.let { window ->
      WindowInsetsControllerCompat(window, window.decorView).show(WindowInsetsCompat.Type.systemBars())
    }
  }

  // ---------------------------------------------------------------------------

  private inner class Client : WebViewClient() {
    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
      val url = request.url.toString()
      if (!url.startsWith("http", ignoreCase = true)) return null

      if (request.isForMainFrame) {
        beginMainFrame(url)
        if (shieldsActive) ensureHostScriptFromIo(url, wait = true)
        return null
      }
      if (!shieldsActive || !ShieldEngine.isReady) return null

      val type = RequestTypes.infer(request)
      if (ShieldEngine.debuggable) debug("req $type ${request.requestHeaders.keys} ${url.take(90)}")
      if (type == "sub_frame") ensureHostScriptFromIo(url, wait = false)

      return when (val verdict = ShieldEngine.check(url, pageUrl, type)) {
        Verdict.Allow -> null
        Verdict.Block -> {
          countBlocked(url)
          if (type == "sub_frame") ShieldResponses.blockedFrame() else ShieldResponses.blocked()
        }
        is Verdict.Redirect -> {
          countBlocked(url)
          ShieldResponses.redirect(verdict.dataUrl)
        }
      }
    }

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
      val url = request.url.toString()
      debug("override main=${request.isForMainFrame} gesture=${request.hasGesture()} redirect=${request.isRedirect} $url")
      if (!request.isForMainFrame) return false
      when (request.url.scheme?.lowercase()) {
        "http", "https" -> Unit
        "about", "data", "blob", "javascript" -> return false
        else -> {
          // intent:, market:, mailto:, tel: ... only when the user actually tapped something.
          if (request.hasGesture()) {
            onExternalLink(mapOf("url" to url))
          } else if (shieldsActive) {
            countBlocked(url)
          }
          return true
        }
      }

      // Redirect blocking: script-initiated navigations to filtered destinations.
      if (shieldsActive && !request.hasGesture() && !request.isRedirect &&
        ShieldEngine.check(url, pageUrl, "document") != Verdict.Allow
      ) {
        countBlocked(url)
        onPopupBlocked(mapOf("url" to url, "kind" to "redirect"))
        return true
      }

      // A server sending us from https back to http on the same host: respect it, don't loop.
      val pending = pendingUpgradeUrl
      if (request.isRedirect && url.startsWith("http://", ignoreCase = true) &&
        pending != null && hostOf(pending) == hostOf(url)
      ) {
        hostOf(url)?.let { httpOnlyHosts.add(it) }
        pendingUpgradeUrl = null
        registerHostScript(url)
        return false
      }

      if (request.method.equals("GET", ignoreCase = true)) {
        val upgraded = upgradeIfNeeded(url)
        if (upgraded != url) {
          beginMainFrame(upgraded)
          registerHostScript(upgraded)
          view.loadUrl(upgraded)
          return true
        }
      }
      registerHostScript(url)
      return false
    }

    override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
      beginMainFrame(url)
      loading = true
      progress = 10
      onLoadStart(mapOf("url" to url))
      emitNavigationState()
    }

    override fun onPageFinished(view: WebView, url: String) {
      if (url == pendingUpgradeUrl) pendingUpgradeUrl = null
      loading = false
      progress = 100
      onLoadEnd(mapOf("url" to url))
      emitNavigationState()
    }

    override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
      emitNavigationState()
    }

    /**
     * The page's renderer crashed or was killed to free memory. Unhandled, Android would close
     * the whole app; instead this tab gets a fresh web view and shows the error page, whose
     * Try again reloads the page.
     */
    override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
      if (view !== webView) {
        (view.parent as? android.view.ViewGroup)?.removeView(view)
        view.destroy()
        return true
      }
      val url = pageUrl.takeIf { it != "about:blank" } ?: initialUrl.orEmpty()
      val crashed = android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O && detail.didCrash()
      destroy()
      webView = createWebView()
      onLoadError(
        mapOf("url" to url, "code" to -10001, "description" to if (crashed) "PAGE_CRASHED" else "PAGE_OUT_OF_MEMORY")
      )
      return true
    }

    override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
      if (!request.isForMainFrame) return
      val url = request.url.toString()
      if (fallBackToHttp(url)) return
      onLoadError(
        mapOf("url" to url, "code" to error.errorCode, "description" to error.description.toString())
      )
    }

    @SuppressLint("WebViewClientOnReceivedSslError")
    override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
      handler.cancel()
      if (fallBackToHttp(error.url)) return
      // Sub-resources (an image, an ad) with bad certificates are simply not loaded; only a
      // failing page replaces the content with the error screen.
      if (error.url != pageUrl && error.url != view.url) return
      onLoadError(mapOf("url" to error.url, "code" to -11, "description" to "Certificate error"))
    }
  }

  private inner class Chrome : WebChromeClient() {
    override fun onProgressChanged(view: WebView, newProgress: Int) {
      progress = newProgress
      onLoadProgress(mapOf("progress" to newProgress / 100.0))
    }

    override fun onReceivedTitle(view: WebView, newTitle: String?) {
      title = newTitle.orEmpty()
      emitNavigationState()
    }

    override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
      debug("createWindow gesture=$isUserGesture dialog=$isDialog")
      if (!isUserGesture && ShieldEngine.blockPopups && shieldsActive) {
        countBlocked()
        onPopupBlocked(mapOf("url" to "", "kind" to "popup"))
        return false
      }
      // Capture the target URL with a throwaway WebView, then let JS open it as a new tab.
      val probe = WebView(view.context)
      if (incognito && privateTabsIsolated) WebViewCompat.setProfile(probe, PRIVATE_PROFILE)
      var handled = false
      // Windows that never navigate (e.g. document.write into about:blank) are discarded.
      main.postDelayed({ if (!handled) { handled = true; probe.destroy() } }, 10_000)
      probe.webViewClient = object : WebViewClient() {
        override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
          if (!handled) {
            handled = true
            val target = request.url.toString()
            debug("popup target $target")
            val isAd = shieldsActive && ShieldEngine.check(target, pageUrl, "document") != Verdict.Allow
            if (isAd) {
              countBlocked(target)
              onPopupBlocked(mapOf("url" to target, "kind" to "popup"))
            } else {
              onOpenWindow(mapOf("url" to target, "incognito" to incognito))
            }
            main.post { v.destroy() }
          }
          return true
        }
      }
      (resultMsg.obj as WebView.WebViewTransport).webView = probe
      resultMsg.sendToTarget()
      return true
    }

    override fun onCloseWindow(window: WebView) {
      onCloseRequest(mapOf("reason" to "script"))
    }

    override fun onShowFileChooser(
      view: WebView,
      callback: ValueCallback<Array<Uri>>,
      params: FileChooserParams
    ): Boolean {
      fileCallback?.onReceiveValue(null)
      fileCallback = callback
      onFileChooser(
        mapOf(
          "acceptTypes" to params.acceptTypes.filter { it.isNotBlank() }.joinToString(","),
          "multiple" to (params.mode == FileChooserParams.MODE_OPEN_MULTIPLE)
        )
      )
      return true
    }

    override fun onShowCustomView(view: View, callback: CustomViewCallback) {
      val window = activity()?.window ?: return callback.onCustomViewHidden()
      exitFullscreen()
      val decor = window.decorView as FrameLayout
      view.setBackgroundColor(Color.BLACK)
      decor.addView(view, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
      fullscreenView = view
      fullscreenCallback = callback
      onFullscreenChange(mapOf("fullscreen" to true))
      matchVideoOrientation()
      WindowCompat.getInsetsController(window, decor).apply {
        hide(WindowInsetsCompat.Type.systemBars())
        systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      }
    }

    override fun onHideCustomView() {
      exitFullscreen()
    }
  }
}
