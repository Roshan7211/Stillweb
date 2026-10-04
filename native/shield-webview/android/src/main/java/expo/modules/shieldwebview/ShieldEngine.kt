package expo.modules.shieldwebview

import android.content.Context
import android.content.SharedPreferences
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.locks.ReentrantReadWriteLock
import kotlin.concurrent.read
import kotlin.concurrent.write

internal sealed class Verdict {
  object Allow : Verdict()
  object Block : Verdict()
  data class Redirect(val dataUrl: String) : Verdict()
}

/**
 * Process-wide owner of the adblock-rust engine.
 *
 * Filter bundles (see scripts/filters/build.mjs) live in two places:
 *   files/shield/bundled  - extracted from APK assets, the offline default
 *   files/shield/active   - the most recent verified download
 * Whichever has the newer manifest version is loaded. Compiled engines are cached as
 * files/shield/engine-<key>.dat so later launches skip list parsing.
 */
internal object ShieldEngine {
  private const val TAG = "ShieldEngine"
  private const val ASSET_DIR = "shield"

  // Guards `handle`: checks hold the read lock, swapping/destroying holds the write lock.
  private val lock = ReentrantReadWriteLock()
  @Volatile private var handle = 0L

  private val executor = Executors.newSingleThreadExecutor { r -> Thread(r, "shield-engine") }
  private val main = Handler(Looper.getMainLooper())
  private val initialized = AtomicBoolean(false)
  private lateinit var context: Context
  private lateinit var prefs: SharedPreferences
  private lateinit var root: File

  @Volatile var version: String? = null
    private set
  @Volatile var source: String = "none"
    private set
  @Volatile var buildMillis = 0L
    private set
  @Volatile var lastError: String? = null
    private set

  /** Bumped when filters or per-site settings change so views drop cached cosmetics. */
  val generation = AtomicInteger(0)

  // Settings pushed from JS (and persisted so a cold start behaves the same before JS runs).
  @Volatile var enabled = true
  @Volatile var httpsUpgrade = true
  @Volatile var blockPopups = true
  @Volatile var cosmeticFiltering = true
  @Volatile var blockThirdPartyCookies = true
  @Volatile var backgroundPlay = true
  /** Stillweb Plus: annoyance lists in the engine and automatic cookie pop-up rejection. */
  @Volatile var calmMode = false
  @Volatile private var disabledSites: Set<String> = emptySet()
  @Volatile private var enabledLists: Set<String>? = null // null = all lists

  private val totalBlocked = AtomicLong(0)
  private val persistScheduled = AtomicBoolean(false)

  // Main thread only: actions waiting for the first engine load (or its failure).
  private val readyWaiters = mutableListOf<() -> Unit>()

  /** Main thread. Runs [action] once filters are loaded, or right away if they are (or failed). */
  fun whenReady(action: () -> Unit) {
    if (isReady || lastError != null) action() else readyWaiters += action
  }

  private fun flushReadyWaiters() {
    val waiting = readyWaiters.toList()
    readyWaiters.clear()
    waiting.forEach { it() }
  }

  /** Called on the main thread after a (re)load; set by ShieldEngineModule. */
  var onEngineChanged: ((Map<String, Any?>) -> Unit)? = null

  @Volatile var debuggable = false
    private set

  val isReady: Boolean
    get() = handle != 0L

  fun initialize(appContext: Context) {
    if (!initialized.compareAndSet(false, true)) return
    context = appContext.applicationContext
    prefs = context.getSharedPreferences("shield_engine", Context.MODE_PRIVATE)
    root = File(context.filesDir, "shield").apply { mkdirs() }

    totalBlocked.set(prefs.getLong("totalBlocked", 0))
    enabledLists = prefs.getStringSet("enabledLists", null)?.toSet()
    disabledSites = prefs.getStringSet("disabledSites", emptySet())!!.toSet()
    enabled = prefs.getBoolean("enabled", true)
    httpsUpgrade = prefs.getBoolean("httpsUpgrade", true)
    blockPopups = prefs.getBoolean("blockPopups", true)
    cosmeticFiltering = prefs.getBoolean("cosmeticFiltering", true)
    blockThirdPartyCookies = prefs.getBoolean("blockThirdPartyCookies", true)
    backgroundPlay = prefs.getBoolean("backgroundPlay", true)
    calmMode = prefs.getBoolean("calmMode", false)

    debuggable = (context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
    // Debug builds: allow chrome://inspect on page content.
    if (debuggable) {
      main.post { android.webkit.WebView.setWebContentsDebuggingEnabled(true) }
    }

    executor.execute { safeLoad { loadBest() } }
  }

  // ---------------------------------------------------------------------------
  // Queries (any thread)

  fun check(url: String, sourceUrl: String, requestType: String): Verdict {
    lock.read {
      val h = handle
      if (h == 0L) return Verdict.Allow
      val out = arrayOfNulls<String>(1)
      return when (AdblockNative.nativeCheck(h, url, sourceUrl, requestType, out)) {
        AdblockNative.BLOCK -> Verdict.Block
        AdblockNative.REDIRECT -> out[0]?.let { Verdict.Redirect(it) } ?: Verdict.Block
        else -> Verdict.Allow
      }
    }
  }

  fun cosmeticResources(url: String): JSONObject? {
    lock.read {
      val h = handle
      if (h == 0L) return null
      return runCatching { JSONObject(AdblockNative.nativeCosmetic(h, url)) }.getOrNull()
    }
  }

  fun hiddenSelectors(classes: JSONArray, ids: JSONArray, exceptions: JSONArray): String {
    val query = JSONObject().put("classes", classes).put("ids", ids).put("exceptions", exceptions)
    lock.read {
      val h = handle
      if (h == 0L) return "[]"
      return AdblockNative.nativeHiddenSelectors(h, query.toString())
    }
  }

  fun shieldsEnabledFor(host: String?): Boolean {
    if (!enabled) return false
    if (host.isNullOrEmpty()) return true
    var h = host.lowercase()
    while (true) {
      if (h in disabledSites) return false
      val dot = h.indexOf('.')
      if (dot < 0) return true
      h = h.substring(dot + 1)
    }
  }

  fun recordBlocked() {
    totalBlocked.incrementAndGet()
    if (persistScheduled.compareAndSet(false, true)) {
      main.postDelayed({
        persistScheduled.set(false)
        prefs.edit().putLong("totalBlocked", totalBlocked.get()).apply()
      }, 2000)
    }
  }

  fun totalBlocked(): Long = totalBlocked.get()

  fun resetStats() {
    totalBlocked.set(0)
    prefs.edit().putLong("totalBlocked", 0).apply()
  }

  // ---------------------------------------------------------------------------
  // Settings

  /** Per-site changes the user made: desktop website, JavaScript off, hidden elements (CSS selectors). */
  data class SiteFix(val desktop: Boolean, val noScript: Boolean, val hidden: List<String>)

  @Volatile private var siteFixes: Map<String, SiteFix> = emptyMap()

  /** `{ "example.com": { desktop, noScript, hidden: [selector] } }`, keyed by site (host without www). */
  fun setSiteFixes(raw: Map<String, Any?>) {
    siteFixes = raw.mapNotNull { (site, value) ->
      val entry = value as? Map<*, *> ?: return@mapNotNull null
      val fix = SiteFix(
        desktop = entry["desktop"] as? Boolean ?: false,
        noScript = entry["noScript"] as? Boolean ?: false,
        hidden = (entry["hidden"] as? List<*>)?.filterIsInstance<String>()?.filter { it.isNotEmpty() } ?: emptyList()
      )
      if (fix.desktop || fix.noScript || fix.hidden.isNotEmpty()) site.lowercase() to fix else null
    }.toMap()
    generation.incrementAndGet()
  }

  /** The fix for a host or the closest parent site that has one. */
  fun siteFixFor(host: String?): SiteFix? {
    if (host.isNullOrEmpty()) return null
    var h = host.lowercase().removePrefix("www.")
    while (true) {
      siteFixes[h]?.let { return it }
      val dot = h.indexOf('.')
      if (dot < 0) return null
      h = h.substring(dot + 1)
    }
  }

  fun setDisabledSites(hosts: Collection<String>) {
    disabledSites = hosts.map { it.lowercase() }.toSet()
    prefs.edit().putStringSet("disabledSites", disabledSites).apply()
    generation.incrementAndGet()
  }

  fun setOptions(options: Map<String, Any?>) {
    (options["enabled"] as? Boolean)?.let { enabled = it }
    (options["httpsUpgrade"] as? Boolean)?.let { httpsUpgrade = it }
    (options["blockPopups"] as? Boolean)?.let { blockPopups = it }
    (options["cosmeticFiltering"] as? Boolean)?.let { cosmeticFiltering = it }
    (options["blockThirdPartyCookies"] as? Boolean)?.let { blockThirdPartyCookies = it }
    (options["backgroundPlay"] as? Boolean)?.let {
      backgroundPlay = it
      if (!it) main.post { MediaPlaybackController.stop(pause = false) }
    }
    (options["calmMode"] as? Boolean)?.let {
      if (it != calmMode) {
        calmMode = it
        // The annoyance lists go in or out of the engine.
        executor.execute { runCatching { loadBest() }.onFailure { e -> Log.w(TAG, "rebuild for Calm Mode failed", e) } }
      }
    }
    prefs.edit()
      .putBoolean("enabled", enabled)
      .putBoolean("httpsUpgrade", httpsUpgrade)
      .putBoolean("blockPopups", blockPopups)
      .putBoolean("cosmeticFiltering", cosmeticFiltering)
      .putBoolean("blockThirdPartyCookies", blockThirdPartyCookies)
      .putBoolean("backgroundPlay", backgroundPlay)
      .putBoolean("calmMode", calmMode)
      .apply()
    generation.incrementAndGet()
  }

  /** Rebuilds the engine with only these list ids (null = all). Result via [onEngineChanged]. */
  fun setEnabledLists(ids: Collection<String>?, done: (Result<String?>) -> Unit) {
    val next = ids?.toSet()
    // Unchanged: the load queued by initialize() (or the current engine) already matches.
    if (next == enabledLists) {
      done(Result.success(version))
      return
    }
    enabledLists = next
    prefs.edit().apply {
      if (next == null) remove("enabledLists") else putStringSet("enabledLists", next)
    }.apply()
    executor.execute { done(runCatching { loadBest(); version }) }
  }

  /**
   * Verifies a downloaded bundle in [staging] (manifest.json + files it lists), makes it the
   * active bundle and rebuilds the engine. Runs on the engine thread.
   */
  fun applyUpdate(staging: File, done: (Result<String?>) -> Unit) {
    executor.execute {
      done(runCatching {
        val manifest = JSONObject(File(staging, "manifest.json").readText())
        val android = manifest.getJSONObject("android")
        val files = mutableListOf<JSONObject>()
        android.getJSONArray("lists").let { a -> for (i in 0 until a.length()) files += a.getJSONObject(i) }
        files += android.getJSONObject("resources")
        for (entry in files) {
          val file = File(staging, entry.getString("file"))
          require(file.canonicalPath.startsWith(staging.canonicalPath)) { "bad path ${entry.getString("file")}" }
          require(file.exists()) { "missing ${entry.getString("file")}" }
          val actual = sha256(file)
          require(actual == entry.getString("sha256")) { "checksum mismatch for ${entry.getString("file")}" }
        }

        val active = File(root, "active")
        val incoming = File(root, "active.incoming")
        incoming.deleteRecursively()
        staging.copyRecursively(incoming, overwrite = true)
        active.deleteRecursively()
        if (!incoming.renameTo(active)) throw IllegalStateException("could not activate update")

        loadBest()
        version
      })
    }
  }

  fun status(): Map<String, Any?> = mapOf(
    "ready" to isReady,
    "version" to version,
    "source" to source,
    "buildMillis" to buildMillis,
    "lastError" to lastError,
    "enabledLists" to enabledLists?.toList(),
    "totalBlocked" to totalBlocked.get()
  )

  // ---------------------------------------------------------------------------
  // Loading (engine thread only)

  private inline fun safeLoad(block: () -> Unit) {
    try {
      block()
    } catch (t: Throwable) {
      lastError = t.message ?: t.toString()
      Log.e(TAG, "engine load failed", t)
      main.post {
        flushReadyWaiters()
        onEngineChanged?.invoke(status())
      }
    }
  }

  private fun loadBest() {
    val bundled = extractBundled()
    val active = File(root, "active").takeIf { File(it, "manifest.json").exists() }
    val bundledVersion = readManifest(bundled).getString("version")
    val activeVersion = active?.let { runCatching { readManifest(it).getString("version") }.getOrNull() }

    // ISO-8601 UTC timestamps compare correctly as strings.
    if (active != null && activeVersion != null && activeVersion > bundledVersion) {
      try {
        buildFrom(active, "downloaded")
        return
      } catch (t: Throwable) {
        Log.w(TAG, "downloaded filters failed to load, falling back to bundled", t)
      }
    }
    buildFrom(bundled, "bundled")
  }

  private fun readManifest(dir: File) = JSONObject(File(dir, "manifest.json").readText())

  /** Copies the APK's filter assets to disk (Rust reads files by path). */
  private fun extractBundled(): File {
    val dir = File(root, "bundled")
    val assetManifest = context.assets.open("$ASSET_DIR/manifest.json").use { it.readBytes() }
    val assetVersion = JSONObject(String(assetManifest)).getString("version")
    val existing = runCatching { readManifest(dir).getString("version") }.getOrNull()
    if (existing == assetVersion) return dir

    dir.deleteRecursively()
    dir.mkdirs()
    val manifest = JSONObject(String(assetManifest))
    val android = manifest.getJSONObject("android")
    val files = mutableListOf<String>()
    android.getJSONArray("lists").let { a -> for (i in 0 until a.length()) files += a.getJSONObject(i).getString("file") }
    files += android.getJSONObject("resources").getString("file")
    for (rel in files) {
      val out = File(dir, rel)
      out.parentFile?.mkdirs()
      context.assets.open("$ASSET_DIR/$rel").use { input -> out.outputStream().use { input.copyTo(it) } }
    }
    // Manifest last, so a partial extraction is retried next time.
    File(dir, "manifest.json").writeBytes(assetManifest)
    return dir
  }

  private fun buildFrom(dir: File, sourceName: String) {
    val started = SystemClock.elapsedRealtime()
    val manifest = readManifest(dir)
    val manifestVersion = manifest.getString("version")
    val android = manifest.getJSONObject("android")
    val wanted = enabledLists

    val paths = mutableListOf<String>()
    val trusted = mutableListOf<Boolean>()
    val ids = mutableListOf<String>()
    val lists = android.getJSONArray("lists")
    for (i in 0 until lists.length()) {
      val entry = lists.getJSONObject(i)
      val id = entry.getString("id")
      if (wanted != null && id !in wanted) continue
      // Calm Mode's annoyance lists only while it's on.
      if (entry.optString("group") == "calm" && !calmMode) continue
      paths += File(dir, entry.getString("file")).absolutePath
      trusted += entry.optBoolean("trusted", false)
      ids += id
    }

    val key = sha256("$manifestVersion|$sourceName|${ids.sorted().joinToString(",")}".toByteArray()).take(16)
    val cache = File(root, "engine-$key.dat")
    var newHandle = 0L
    if (cache.exists()) {
      newHandle = AdblockNative.nativeDeserialize(cache.readBytes())
      if (newHandle == 0L) cache.delete()
    }
    if (newHandle == 0L) {
      newHandle = AdblockNative.nativeCreate(paths.toTypedArray(), trusted.toBooleanArray())
      if (newHandle == 0L) throw IllegalStateException("engine build failed")
      AdblockNative.nativeSerialize(newHandle)?.let { bytes ->
        root.listFiles { f -> f.name.startsWith("engine-") && f.name.endsWith(".dat") }?.forEach { it.delete() }
        val tmp = File(root, "${cache.name}.tmp")
        tmp.writeBytes(bytes)
        tmp.renameTo(cache)
      }
    }
    val resources = File(dir, android.getJSONObject("resources").getString("file"))
    val resourceCount = AdblockNative.nativeUseResources(newHandle, resources.absolutePath)
    if (resourceCount < 0) Log.w(TAG, "could not load resources from $resources")

    lock.write {
      val old = handle
      handle = newHandle
      if (old != 0L) AdblockNative.nativeDestroy(old)
    }
    version = manifestVersion
    source = sourceName
    lastError = null
    buildMillis = SystemClock.elapsedRealtime() - started
    generation.incrementAndGet()
    Log.i(TAG, "loaded $sourceName filters $manifestVersion (${ids.size} lists, $resourceCount resources) in ${buildMillis}ms")
    main.post {
      flushReadyWaiters()
      onEngineChanged?.invoke(status())
    }
  }

  private fun sha256(file: File): String = file.inputStream().use { input ->
    val digest = MessageDigest.getInstance("SHA-256")
    val buffer = ByteArray(64 * 1024)
    while (true) {
      val n = input.read(buffer)
      if (n < 0) break
      digest.update(buffer, 0, n)
    }
    digest.digest().joinToString("") { "%02x".format(it) }
  }

  private fun sha256(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
}
