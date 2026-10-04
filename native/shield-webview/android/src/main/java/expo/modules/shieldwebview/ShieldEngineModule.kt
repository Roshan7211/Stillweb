package expo.modules.shieldwebview

import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.os.Environment
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.URLUtil
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewDatabase
import androidx.webkit.ProfileStore
import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebViewFeature
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.util.concurrent.Executor

class ShieldEngineModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "React context unavailable" }.applicationContext

  override fun definition() = ModuleDefinition {
    Name("ShieldEngine")

    Events("onEngineChanged", "onSleepTimerFired")

    Constant("privateTabsIsolated") { ShieldWebView.privateTabsIsolated }

    OnCreate {
      ShieldEngine.onEngineChanged = { status -> sendEvent("onEngineChanged", status) }
      SleepTimer.onFired = { sendEvent("onSleepTimerFired", emptyMap<String, Any>()) }
      ShieldEngine.initialize(context)
    }

    OnDestroy {
      ShieldEngine.onEngineChanged = null
      SleepTimer.onFired = null
    }

    OnActivityEntersForeground {
      MediaPlaybackController.onAppForeground()
    }

    AsyncFunction("getStatus") { ShieldEngine.status() }

    /** `directory` holds a downloaded bundle: manifest.json plus the files it lists. */
    AsyncFunction("applyFilterUpdate") { directory: String, promise: Promise ->
      val dir = File(directory.removePrefix("file://"))
      ShieldEngine.applyUpdate(dir) { result ->
        result.fold({ promise.resolve(it) }, { promise.reject("E_FILTER_UPDATE", it.message, it) })
      }
    }

    AsyncFunction("setEnabledLists") { ids: List<String>?, promise: Promise ->
      ShieldEngine.setEnabledLists(ids) { result ->
        result.fold({ promise.resolve(it) }, { promise.reject("E_FILTER_LISTS", it.message, it) })
      }
    }

    Function("setDisabledSites") { hosts: List<String> -> ShieldEngine.setDisabledSites(hosts) }

    Function("setOptions") { options: Map<String, Any?> -> ShieldEngine.setOptions(options) }

    // Listen Mode: pause all media after this many seconds (null cancels).
    Function("setSleepTimer") { seconds: Double? -> SleepTimer.set(seconds) }

    Function("resetStats") { ShieldEngine.resetStats() }

    AsyncFunction("clearBrowsingData") { promise: Promise ->
      CookieManager.getInstance().removeAllCookies {
        CookieManager.getInstance().flush()
        WebStorage.getInstance().deleteAllData()
        WebViewDatabase.getInstance(context).clearHttpAuthUsernamePassword()
        // The HTTP cache is shared by all WebViews; any instance can clear it.
        WebView(context).apply { clearCache(true) }.destroy()
        clearPrivateProfile()
        promise.resolve(null)
      }
    }.runOnQueue(Queues.MAIN)

    /** Call once no private tab is open any more. */
    AsyncFunction("clearPrivateData") {
      clearPrivateProfile()
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("startDownload") { options: Map<String, Any?> ->
      val url = options["url"] as? String ?: throw IllegalArgumentException("url is required")
      val contentDisposition = options["contentDisposition"] as? String
      val mimeType = options["mimeType"] as? String
      val incognito = options["incognito"] as? Boolean ?: false
      val fileName = URLUtil.guessFileName(url, contentDisposition, mimeType)

      val request = DownloadManager.Request(Uri.parse(url)).apply {
        mimeType?.takeIf { it.isNotEmpty() }?.let { setMimeType(it) }
        (options["userAgent"] as? String)?.takeIf { it.isNotEmpty() }?.let { addRequestHeader("User-Agent", it) }
        cookiesFor(url, incognito)?.let { addRequestHeader("Cookie", it) }
        setTitle(fileName)
        setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
        setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName)
      }
      val id = downloadManager().enqueue(request)
      mapOf("id" to id.toDouble(), "fileName" to fileName)
    }

    AsyncFunction("getDownloads") { ids: List<Double> ->
      if (ids.isEmpty()) return@AsyncFunction emptyList<Map<String, Any?>>()
      val query = DownloadManager.Query().setFilterById(*ids.map { it.toLong() }.toLongArray())
      val out = mutableListOf<Map<String, Any?>>()
      downloadManager().query(query)?.use { c ->
        while (c.moveToNext()) {
          val status = when (c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))) {
            DownloadManager.STATUS_SUCCESSFUL -> "done"
            DownloadManager.STATUS_FAILED -> "failed"
            DownloadManager.STATUS_PAUSED -> "paused"
            DownloadManager.STATUS_PENDING -> "pending"
            else -> "running"
          }
          out += mapOf(
            "id" to c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_ID)).toDouble(),
            "status" to status,
            "bytes" to c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR)).toDouble(),
            "total" to c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES)).toDouble()
          )
        }
      }
      out
    }

    AsyncFunction("openDownload") { id: Double ->
      val dm = downloadManager()
      val uri = dm.getUriForDownloadedFile(id.toLong()) ?: return@AsyncFunction false
      val intent = Intent(Intent.ACTION_VIEW)
        .setDataAndType(uri, dm.getMimeTypeForDownloadedFile(id.toLong()))
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
      try {
        context.startActivity(intent)
        true
      } catch (e: ActivityNotFoundException) {
        false
      }
    }

    /**
     * Debug builds only: route WebView traffic through a proxy, e.g. "127.0.0.1:8899" forwarded
     * from a computer with `adb reverse` when the test device has no network of its own.
     */
    AsyncFunction("setDebugProxy") { hostPort: String?, promise: Promise ->
      val debuggable = (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
      if (!debuggable || !WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
        promise.resolve(false)
        return@AsyncFunction
      }
      val controller = ProxyController.getInstance()
      val executor = Executor { it.run() }
      if (hostPort.isNullOrEmpty()) {
        controller.clearProxyOverride(executor) { promise.resolve(true) }
      } else {
        val config = ProxyConfig.Builder().addProxyRule(hostPort).build()
        controller.setProxyOverride(config, executor) { promise.resolve(true) }
      }
    }.runOnQueue(Queues.MAIN)

    /** Keeps private tabs out of screenshots and the recent-apps preview. */
    AsyncFunction("setSecureWindow") { secure: Boolean ->
      appContext.currentActivity?.window?.let { window ->
        if (secure) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
      }
      Unit
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("openExternal") { url: String ->
      val intent = if (url.startsWith("intent:")) {
        Intent.parseUri(url, Intent.URI_INTENT_SCHEME).apply {
          // Never let a page target our own components or grant URI permissions.
          component = null
          selector = null
          flags = flags and (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION).inv()
          addCategory(Intent.CATEGORY_BROWSABLE)
        }
      } else {
        Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE)
      }
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      try {
        context.startActivity(intent)
        true
      } catch (e: ActivityNotFoundException) {
        false
      }
    }
  }

  private fun downloadManager() = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager

  private fun cookiesFor(url: String, incognito: Boolean): String? {
    val manager = if (incognito && ShieldWebView.privateTabsIsolated) {
      ProfileStore.getInstance().getProfile(ShieldWebView.PRIVATE_PROFILE)?.cookieManager
    } else {
      CookieManager.getInstance()
    }
    return manager?.getCookie(url)
  }

  private fun clearPrivateProfile() {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) return
    val store = ProfileStore.getInstance()
    try {
      store.deleteProfile(ShieldWebView.PRIVATE_PROFILE)
    } catch (e: IllegalStateException) {
      // Still in use by a WebView that hasn't been destroyed yet: wipe its data instead.
      store.getProfile(ShieldWebView.PRIVATE_PROFILE)?.let { profile ->
        profile.cookieManager.removeAllCookies(null)
        profile.webStorage.deleteAllData()
      }
    }
  }
}
