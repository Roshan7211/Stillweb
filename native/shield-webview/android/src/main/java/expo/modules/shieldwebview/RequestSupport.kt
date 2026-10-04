package expo.modules.shieldwebview

import android.content.Context
import android.util.Base64
import android.util.LruCache
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.IOException
import java.io.InputStream

/**
 * WebView doesn't report a request's resource type, so infer adblock-rust's type name
 * from fetch metadata, the Accept header, or the file extension.
 */
internal object RequestTypes {
  private val extensionTypes = mapOf(
    "js" to "script", "mjs" to "script",
    "css" to "stylesheet",
    "png" to "image", "jpg" to "image", "jpeg" to "image", "gif" to "image", "webp" to "image",
    "svg" to "image", "ico" to "image", "avif" to "image", "bmp" to "image",
    "woff" to "font", "woff2" to "font", "ttf" to "font", "otf" to "font", "eot" to "font",
    "mp4" to "media", "webm" to "media", "m3u8" to "media", "mpd" to "media", "mp3" to "media",
    "m4a" to "media", "m4s" to "media", "aac" to "media", "ogg" to "media", "ts" to "media",
    "json" to "xmlhttprequest",
    "html" to "sub_frame", "htm" to "sub_frame"
  )

  private val fetchDestTypes = mapOf(
    "script" to "script", "worker" to "script", "sharedworker" to "script", "serviceworker" to "script",
    "style" to "stylesheet",
    "image" to "image",
    "font" to "font",
    "audio" to "media", "video" to "media", "track" to "media",
    "iframe" to "sub_frame", "frame" to "sub_frame", "document" to "sub_frame",
    "object" to "object", "embed" to "object",
    "empty" to "xmlhttprequest"
  )

  fun infer(request: WebResourceRequest): String {
    val headers = request.requestHeaders
    header(headers, "Sec-Fetch-Dest")?.let { dest -> fetchDestTypes[dest.lowercase()]?.let { return it } }

    val accept = header(headers, "Accept").orEmpty()
    when {
      accept.startsWith("text/css") -> return "stylesheet"
      accept.startsWith("image/") -> return "image"
      accept.startsWith("text/html") -> return "sub_frame"
      accept.startsWith("application/json") -> return "xmlhttprequest"
    }
    if (header(headers, "X-Requested-With").equals("XMLHttpRequest", ignoreCase = true)) {
      return "xmlhttprequest"
    }

    val path = request.url.path.orEmpty()
    val dot = path.lastIndexOf('.')
    if (dot >= 0 && dot > path.lastIndexOf('/')) {
      extensionTypes[path.substring(dot + 1).lowercase()]?.let { return it }
    }

    // No extension. WebView hides fetch metadata, so use what each request kind sends:
    // media uses Range, fetch/XHR use non-GET methods or CORS (Origin), and <script src>
    // is a plain GET for "*/*". Ad scripts are often served from extensionless URLs.
    if (header(headers, "Range") != null) return "media"
    if (!request.method.equals("GET", ignoreCase = true)) return "xmlhttprequest"
    if (header(headers, "Origin") != null) return "xmlhttprequest"
    if (accept == "*/*") return "script"
    return "other"
  }

  private fun header(headers: Map<String, String>, name: String): String? =
    headers[name] ?: headers.entries.firstOrNull { it.key.equals(name, ignoreCase = true) }?.value
}

internal object ShieldResponses {
  /**
   * A stream that fails when WebView probes it. Chromium's stream reader calls
   * available() before sending headers, so the request ends with net::ERR_FAILED, which
   * pages observe exactly like an extension-blocked request (fetch rejects, onerror fires).
   */
  private object FailingStream : InputStream() {
    override fun read(): Int = throw IOException("blocked")
    override fun read(b: ByteArray, off: Int, len: Int): Int = throw IOException("blocked")
    override fun available(): Int = throw IOException("blocked")
  }

  fun blocked(): WebResourceResponse = WebResourceResponse("text/plain", "utf-8", FailingStream)

  /** Blocked frames get an empty page instead of Chromium's error page inside the ad slot. */
  fun blockedFrame(): WebResourceResponse = WebResourceResponse(
    "text/html", "utf-8", 200, "OK", mapOf("Cache-Control" to "no-store"),
    ByteArrayInputStream("<!doctype html><title></title>".toByteArray())
  )

  private class Decoded(val mime: String, val bytes: ByteArray)
  private val decodedCache = LruCache<String, Decoded>(32)

  /** Serves a `$redirect` resource (a data: URL from adblock-rust) as the response body. */
  fun redirect(dataUrl: String): WebResourceResponse {
    val decoded = decodedCache.get(dataUrl) ?: decode(dataUrl)?.also { decodedCache.put(dataUrl, it) }
      ?: return blocked()
    return WebResourceResponse(
      decoded.mime,
      if (decoded.mime.startsWith("text/") || decoded.mime.contains("javascript") || decoded.mime.contains("json")) "utf-8" else null,
      200,
      "OK",
      mapOf("Access-Control-Allow-Origin" to "*", "Cache-Control" to "no-store"),
      ByteArrayInputStream(decoded.bytes)
    )
  }

  private fun decode(dataUrl: String): Decoded? {
    if (!dataUrl.startsWith("data:")) return null
    val comma = dataUrl.indexOf(',')
    if (comma < 0) return null
    val meta = dataUrl.substring(5, comma)
    val mime = meta.substringBefore(';').ifEmpty { "text/plain" }
    val payload = dataUrl.substring(comma + 1)
    val bytes = if (meta.endsWith(";base64")) {
      runCatching { Base64.decode(payload, Base64.DEFAULT) }.getOrNull() ?: return null
    } else {
      java.net.URLDecoder.decode(payload, "UTF-8").toByteArray()
    }
    return Decoded(mime, bytes)
  }
}

/** Builds the page-side scripts in web/shieldjs/ for injection at document start. */
internal object CosmeticScripts {
  @Volatile private var hostTemplate: String? = null
  @Volatile private var genericScript: String? = null
  @Volatile private var privacyScript: String? = null

  private val assetCache = java.util.concurrent.ConcurrentHashMap<String, String>()

  /** Reads web/shieldjs/<name> once and caches it. */
  fun script(context: Context, name: String): String =
    assetCache.getOrPut(name) { readAsset(context, "shieldjs/$name") }

  fun privacy(context: Context): String =
    privacyScript ?: readAsset(context, "shieldjs/privacy.js").also { privacyScript = it }

  fun generic(context: Context): String =
    genericScript ?: readAsset(context, "shieldjs/cosmetic-generic.js").also { genericScript = it }

  /** Calm Mode's cookie pop-up script (DuckDuckGo autoconsent, MPL-2.0; ios/Resources/vendor). */
  fun autoconsent(context: Context): String =
    assetCache.getOrPut("autoconsent.js") { readAsset(context, "autoconsent.js") }

  /**
   * Script for one hostname: scriptlets first (they must run before page scripts), then
   * specific hide rules and procedural filters. Returns null when there is nothing to inject.
   */
  fun forHost(context: Context, resources: JSONObject, cosmetic: Boolean): String? {
    val hide = resources.optJSONArray("hide_selectors") ?: JSONArray()
    val procedural = resources.optJSONArray("procedural_actions") ?: JSONArray()
    val scriptlets = resources.optString("injected_script", "")
    val hasCosmetics = cosmetic && (hide.length() > 0 || procedural.length() > 0)
    if (!hasCosmetics && scriptlets.isBlank()) return null

    val out = StringBuilder()
    if (scriptlets.isNotBlank()) {
      out.append("(function(){\n").append(scriptlets).append("\n})();\n")
    }
    if (hasCosmetics) {
      val template = hostTemplate ?: readAsset(context, "shieldjs/cosmetic-host.js").also { hostTemplate = it }
      val config = JSONObject().put("hide", hide).put("procedural", procedural).toString()
      out.append(template.replace("__SHIELD_CONFIG__", config))
    }
    return out.toString()
  }

  private fun readAsset(context: Context, path: String): String =
    context.assets.open(path).bufferedReader().use { it.readText() }
}
