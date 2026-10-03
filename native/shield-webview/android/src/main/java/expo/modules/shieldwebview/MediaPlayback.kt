package expo.modules.shieldwebview

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.webkit.JavaScriptReplyProxy
import org.json.JSONObject
import java.lang.ref.WeakReference
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * Tracks the tab that is playing audible media and mirrors it in a foreground service
 * notification, so playback survives switching apps and screen-off. All calls happen on
 * the main thread (WebMessageListener callbacks, service callbacks, view lifecycle).
 */
internal object MediaPlaybackController {
  data class State(
    val title: String,
    val subtitle: String,
    /** Site the media plays on, shown in the notification header. */
    val site: String,
    val playing: Boolean,
    val incognito: Boolean,
    val positionMs: Long = 0,
    /** 0 for live streams and unknown lengths (no seek bar). */
    val durationMs: Long = 0,
    val rate: Float = 1f,
    /** elapsedRealtime when positionMs was measured; the system extrapolates from it. */
    val positionAt: Long = SystemClock.elapsedRealtime(),
    val artworkUrl: String = "",
    val canPrevious: Boolean = false,
    val canNext: Boolean = false,
  )

  /**
   * How long the session (and its foreground service) survives with nothing playing.
   * Gaps between tracks, buffering and short pauses must not end it: Android only lets a
   * media service start while the app is in the foreground, so a service stopped in the
   * background can't come back for the next track.
   */
  private const val IDLE_TIMEOUT_MS = 10 * 60 * 1000L

  private val main = Handler(Looper.getMainLooper())
  private val idleStop = Runnable { stop(pause = false) }

  private var view: WeakReference<ShieldWebView>? = null
  private var proxy: JavaScriptReplyProxy? = null
  private var context: Context? = null

  var state: State? = null
    private set

  /** Artwork for the current track (null while loading, for private tabs, or if none). */
  var artwork: Bitmap? = null
    private set
  private var artworkUrl = ""
  private val artworkLoader = Executors.newSingleThreadExecutor { r -> Thread(r, "stillweb-artwork") }

  fun isSessionView(v: ShieldWebView): Boolean = state != null && view?.get() === v

  fun onMediaState(v: ShieldWebView, replyProxy: JavaScriptReplyProxy, data: JSONObject, pageTitle: String, host: String) {
    if (!ShieldEngine.backgroundPlay) return
    val playing = data.optBoolean("playing")
    val active = data.optBoolean("active")
    val isCurrent = view?.get() === v
    // Another tab pausing/stopping doesn't affect the current session.
    if (!isCurrent && !playing) return
    if (!active) {
      // Ended, emptied or replaced: keep the session briefly so the next track can continue.
      if (isCurrent) {
        state = state?.copy(playing = false, positionAt = SystemClock.elapsedRealtime())
        publish()
        main.removeCallbacks(idleStop)
        main.postDelayed(idleStop, IDLE_TIMEOUT_MS)
      }
      return
    }
    if (!isCurrent || playing) {
      // A new tab took over playback: pause the old one, like a single media session.
      if (!isCurrent) proxy?.let { runCatching { it.postMessage("pause") } }
      view = WeakReference(v)
      proxy = replyProxy
    }
    context = v.context.applicationContext
    main.removeCallbacks(idleStop)
    if (!playing) main.postDelayed(idleStop, IDLE_TIMEOUT_MS)

    val previous = state
    val position = if (data.has("position")) (data.optDouble("position", 0.0) * 1000).toLong() else null
    val base = if (v.incognito) {
      // Private tabs never reveal what is playing, or which site.
      State("Private tab", "Playing media", "", playing, true)
    } else {
      State(
        title = data.optString("title").ifBlank { pageTitle }.ifBlank { host },
        subtitle = data.optString("artist").ifBlank { data.optString("album") },
        site = host,
        playing = playing,
        incognito = false,
        artworkUrl = data.optString("artwork"),
        canPrevious = data.optBoolean("canPrevious"),
        canNext = data.optBoolean("canNext"),
      )
    }
    val now = SystemClock.elapsedRealtime()
    state = base.copy(
      durationMs = (data.optDouble("duration", 0.0) * 1000).toLong().coerceAtLeast(0),
      rate = data.optDouble("rate", 1.0).toFloat(),
      // Without a fresh position, carry the old one forward so the seek bar doesn't jump.
      positionMs = position ?: previous?.let { estimatedPosition(it, now) } ?: 0,
      positionAt = now,
    )
    loadArtwork(state!!)
    publish()
  }

  /** Where playback is now, extrapolated from the last report. */
  private fun estimatedPosition(s: State, now: Long): Long =
    if (s.playing) s.positionMs + ((now - s.positionAt) * s.rate).toLong() else s.positionMs

  private fun loadArtwork(s: State) {
    val url = if (s.incognito) "" else s.artworkUrl
    if (url == artworkUrl) return
    artworkUrl = url
    artwork = null
    if (!url.startsWith("https://") && !url.startsWith("http://")) return
    artworkLoader.execute {
      val bitmap = artworkCandidates(url).firstNotNullOfOrNull { runCatching { downloadArtwork(it) }.getOrNull() }
      main.post {
        // Ignore if the track changed while downloading.
        if (artworkUrl == url && bitmap != null) {
          artwork = bitmap
          publish()
        }
      }
    }
  }

  /**
   * YouTube hands out small 16:9 thumbnails; ask for the large ones first
   * (maxresdefault doesn't exist for every video, so fall back to hqdefault).
   */
  private fun artworkCandidates(url: String): List<String> {
    val match = Regex("^https://i\\.ytimg\\.com/vi(?:_webp)?/([\\w-]{6,})/").find(url) ?: return listOf(url)
    val id = match.groupValues[1]
    return listOf("https://i.ytimg.com/vi/$id/maxresdefault.jpg", "https://i.ytimg.com/vi/$id/hqdefault.jpg", url)
  }

  /** Site icons are small; anything below this is too blurry to show as artwork. */
  private const val MIN_ARTWORK_SIDE = 96

  /** Centre square, like an album cover; YouTube's letterbox bars are trimmed by the crop. */
  private fun squareCrop(source: Bitmap): Bitmap {
    // hqdefault is 4:3 with black bars around a 16:9 picture: drop the bars first.
    val src = if (source.width * 3 == source.height * 4) {
      val pictureHeight = source.width * 9 / 16
      Bitmap.createBitmap(source, 0, (source.height - pictureHeight) / 2, source.width, pictureHeight)
    } else {
      source
    }
    val side = minOf(src.width, src.height)
    val square = Bitmap.createBitmap(src, (src.width - side) / 2, (src.height - side) / 2, side, side)
    return if (side > 512) Bitmap.createScaledBitmap(square, 512, 512, true) else square
  }

  private fun downloadArtwork(url: String): Bitmap? {
    val connection = (URL(url).openConnection() as HttpURLConnection).apply {
      connectTimeout = 5000
      readTimeout = 5000
      instanceFollowRedirects = true
    }
    try {
      if (connection.responseCode !in 200..299) return null
      val bytes = connection.inputStream.use { input ->
        val out = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(16 * 1024)
        while (true) {
          val n = input.read(buffer)
          if (n < 0) break
          out.write(buffer, 0, n)
          if (out.size() > 4 * 1024 * 1024) return null // not a cover image
        }
        out.toByteArray()
      }
      // Decode at roughly notification size.
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
      var sample = 1
      while (bounds.outWidth / (sample * 2) >= 512 && bounds.outHeight / (sample * 2) >= 512) sample *= 2
      val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
        ?: return null
      // YouTube's "no thumbnail" placeholder for missing sizes is 120x90.
      if (decoded.width <= 120 && decoded.height == 90) return null
      if (minOf(decoded.width, decoded.height) < MIN_ARTWORK_SIDE) return null
      return squareCrop(decoded)
    } finally {
      connection.disconnect()
    }
  }

  fun command(command: String) {
    if (ShieldEngine.debuggable) Log.d("StillwebMedia", "command $command")
    val p = proxy ?: return
    runCatching { p.postMessage(command) }.onFailure { stop(pause = false) }
  }

  /** Ends the session: optionally pauses the page and removes the notification. */
  fun stop(pause: Boolean = true) {
    main.removeCallbacks(idleStop)
    if (pause) command("pause")
    state = null
    view = null
    proxy = null
    artwork = null
    artworkUrl = ""
    MediaPlaybackService.instance?.shutdown()
  }

  fun onViewDestroyed(v: ShieldWebView) {
    if (view?.get() === v) stop(pause = false)
  }

  /** Back in the app with nothing playing: the notification is no longer needed. */
  fun onAppForeground() {
    if (state?.playing != true) stop(pause = false)
  }

  private fun publish() {
    val service = MediaPlaybackService.instance
    if (service != null) {
      service.update()
      return
    }
    if (state?.playing != true) return
    val ctx = context ?: return
    try {
      ContextCompat.startForegroundService(ctx, Intent(ctx, MediaPlaybackService::class.java))
    } catch (t: Throwable) {
      // Starting a foreground service from the background is restricted on newer Android.
      Log.w("StillwebMedia", "could not start playback service", t)
    }
  }
}

class MediaPlaybackService : Service() {
  companion object {
    private const val CHANNEL_ID = "playback"
    private const val NOTIFICATION_ID = 0x5711
    private const val ACTION_PLAY = "app.stillweb.media.PLAY"
    private const val ACTION_PAUSE = "app.stillweb.media.PAUSE"
    private const val ACTION_NEXT = "app.stillweb.media.NEXT"
    private const val ACTION_PREVIOUS = "app.stillweb.media.PREVIOUS"
    private const val ACTION_STOP = "app.stillweb.media.STOP"
    private const val ACTION_REWIND = "app.stillweb.media.REWIND"
    private const val ACTION_FORWARD = "app.stillweb.media.FORWARD"
    private const val ACCENT = 0xFF2563EB.toInt()

    @Volatile
    internal var instance: MediaPlaybackService? = null
      private set
  }

  private lateinit var session: MediaSessionCompat
  private var wifiLock: WifiManager.WifiLock? = null
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    instance = this
    val manager = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= 26 && manager.getNotificationChannel(CHANNEL_ID) == null) {
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "Media playback", NotificationManager.IMPORTANCE_LOW).apply {
          setShowBadge(false)
          lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        }
      )
    }
    session = MediaSessionCompat(this, "Stillweb").apply {
      setCallback(object : MediaSessionCompat.Callback() {
        override fun onPlay() = MediaPlaybackController.command("play")
        override fun onPause() = MediaPlaybackController.command("pause")
        override fun onSkipToNext() = MediaPlaybackController.command("next")
        override fun onSkipToPrevious() = MediaPlaybackController.command("previous")
        override fun onStop() = MediaPlaybackController.stop()
        override fun onFastForward() = MediaPlaybackController.command("seekforward")
        override fun onRewind() = MediaPlaybackController.command("seekbackward")
        override fun onSeekTo(pos: Long) = MediaPlaybackController.command("seekto:${pos / 1000.0}")
      })
      isActive = true
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_PLAY -> MediaPlaybackController.command("play")
      ACTION_PAUSE -> MediaPlaybackController.command("pause")
      ACTION_NEXT -> MediaPlaybackController.command("next")
      ACTION_PREVIOUS -> MediaPlaybackController.command("previous")
      ACTION_REWIND -> MediaPlaybackController.command("seekbackward")
      ACTION_FORWARD -> MediaPlaybackController.command("seekforward")
      ACTION_STOP -> {
        MediaPlaybackController.stop()
        return START_NOT_STICKY
      }
    }
    if (!update()) shutdown()
    return START_NOT_STICKY
  }

  /** Swiping the app away from recents ends playback, like closing a tab. */
  override fun onTaskRemoved(rootIntent: Intent?) {
    MediaPlaybackController.stop()
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    holdLocks(false)
    instance = null
    session.isActive = false
    session.release()
    super.onDestroy()
  }

  /**
   * While media plays: keep Wi-Fi at full performance and the CPU awake, so streams keep
   * buffering with the screen off (what music apps do). Released as soon as playback stops.
   */
  private fun holdLocks(hold: Boolean) {
    if (hold) {
      if (wifiLock == null) {
        val wifi = applicationContext.getSystemService(WifiManager::class.java)
        @Suppress("DEPRECATION")
        val mode = if (Build.VERSION.SDK_INT >= 29) WifiManager.WIFI_MODE_FULL_LOW_LATENCY else WifiManager.WIFI_MODE_FULL_HIGH_PERF
        wifiLock = wifi?.createWifiLock(mode, "Stillweb:playback")?.apply { setReferenceCounted(false) }
      }
      if (wakeLock == null) {
        wakeLock = getSystemService(PowerManager::class.java)
          ?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Stillweb:playback")
          ?.apply { setReferenceCounted(false) }
      }
      runCatching { wifiLock?.acquire() }
      // Re-armed on every update; the timeout is a safety net if an update is ever missed.
      runCatching { wakeLock?.acquire(30 * 60 * 1000L) }
    } else {
      runCatching { if (wifiLock?.isHeld == true) wifiLock?.release() }
      runCatching { if (wakeLock?.isHeld == true) wakeLock?.release() }
    }
  }

  internal fun shutdown() {
    holdLocks(false)
    if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE) else @Suppress("DEPRECATION") stopForeground(true)
    stopSelf()
  }

  /** Refreshes session + notification from the controller. Returns false when idle. */
  internal fun update(): Boolean {
    val state = MediaPlaybackController.state ?: return false
    val art = MediaPlaybackController.artwork
    holdLocks(state.playing)

    session.setMetadata(
      MediaMetadataCompat.Builder()
        .putString(MediaMetadataCompat.METADATA_KEY_TITLE, state.title)
        // System media controls show the artist line; fall back to the site so it's never blank.
        .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, state.subtitle.ifBlank { state.site })
        .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_SUBTITLE, state.subtitle.ifBlank { state.site })
        .apply {
          if (state.durationMs > 0) putLong(MediaMetadataCompat.METADATA_KEY_DURATION, state.durationMs)
          // System media controls (Android 11+) and the lock screen use this artwork.
          if (art != null) putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, art)
        }
        .build()
    )

    var actions = PlaybackStateCompat.ACTION_PLAY or PlaybackStateCompat.ACTION_PAUSE or
      PlaybackStateCompat.ACTION_PLAY_PAUSE or PlaybackStateCompat.ACTION_STOP or
      PlaybackStateCompat.ACTION_SKIP_TO_NEXT or PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
    // A seek bar only makes sense for media with a known length (not live radio).
    if (state.durationMs > 0) {
      actions = actions or PlaybackStateCompat.ACTION_SEEK_TO or
        PlaybackStateCompat.ACTION_FAST_FORWARD or PlaybackStateCompat.ACTION_REWIND
    }
    session.setPlaybackState(
      PlaybackStateCompat.Builder()
        .setActions(actions)
        .setState(
          if (state.playing) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED,
          if (state.durationMs > 0) state.positionMs else PlaybackStateCompat.PLAYBACK_POSITION_UNKNOWN,
          if (state.playing) state.rate else 0f,
          state.positionAt
        )
        .build()
    )

    val notification = buildNotification(state, art)
    if (Build.VERSION.SDK_INT >= 29) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    return true
  }

  private fun action(action: String, requestCode: Int): PendingIntent =
    PendingIntent.getService(
      this,
      requestCode,
      Intent(this, MediaPlaybackService::class.java).setAction(action),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

  private fun buildNotification(state: MediaPlaybackController.State, art: Bitmap?): Notification {
    val launch = packageManager.getLaunchIntentForPackage(packageName)?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
    session.setSessionActivity(launch)

    // Sites with a playlist (music apps) get previous/next; videos and podcasts get 10-second
    // skips instead, which is what those buttons can actually do there. Live streams (radio)
    // can't skip at all, so they only get play/pause.
    val seekable = state.durationMs > 0
    val previous = when {
      state.canPrevious -> NotificationCompat.Action(R.drawable.sw_ic_previous, "Previous", action(ACTION_PREVIOUS, 3))
      seekable -> NotificationCompat.Action(R.drawable.sw_ic_rewind_10, "Back 10 seconds", action(ACTION_REWIND, 7))
      else -> null
    }
    val next = when {
      state.canNext -> NotificationCompat.Action(R.drawable.sw_ic_next, "Next", action(ACTION_NEXT, 4))
      seekable -> NotificationCompat.Action(R.drawable.sw_ic_forward_10, "Forward 10 seconds", action(ACTION_FORWARD, 8))
      else -> null
    }
    val playPause = if (state.playing) {
      NotificationCompat.Action(R.drawable.sw_ic_pause, "Pause", action(ACTION_PAUSE, 2))
    } else {
      NotificationCompat.Action(R.drawable.sw_ic_play, "Play", action(ACTION_PLAY, 1))
    }
    val close = NotificationCompat.Action(R.drawable.sw_ic_close, "Close", action(ACTION_STOP, 6))
    val actions = listOfNotNull(previous, playPause, next, close)
    // Collapsed view: the transport buttons (everything except Close).
    val compact = IntArray(actions.size - 1) { it }

    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_stat_stillweb)
      .setColor(ACCENT)
      .setContentTitle(state.title)
      .setContentText(state.subtitle.ifBlank { state.site })
      // The site, next to the app name in the header (e.g. "Stillweb • music.youtube.com").
      .apply { if (state.subtitle.isNotBlank() && state.site.isNotBlank()) setSubText(state.site) }
      .setLargeIcon(art)
      .setContentIntent(launch)
      .setDeleteIntent(action(ACTION_STOP, 5))
      .setOngoing(state.playing)
      .setShowWhen(false)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
      // Private tabs never show what is playing on the lock screen.
      .setVisibility(if (state.incognito) NotificationCompat.VISIBILITY_PRIVATE else NotificationCompat.VISIBILITY_PUBLIC)
      .apply { actions.forEach { addAction(it) } }
      .setStyle(
        androidx.media.app.NotificationCompat.MediaStyle()
          .setMediaSession(session.sessionToken)
          .setShowActionsInCompactView(*compact)
          .setShowCancelButton(true)
          .setCancelButtonIntent(action(ACTION_STOP, 9))
      )
      .build()
  }
}
