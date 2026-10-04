package expo.modules.shieldwebview

import android.os.Handler
import android.os.Looper
import java.util.Collections
import java.util.WeakHashMap

/**
 * Listen Mode's sleep timer (Stillweb Plus). Runs natively so it fires while the app is in
 * the background (JS timers pause there); when it does, all media in every tab is paused.
 */
internal object SleepTimer {
  /** Pauses media in the page; also marks it as the user's pause for background play. */
  const val PAUSE_SCRIPT =
    "(function(){try{if(window.__stillwebUserPause)window.__stillwebUserPause();}catch(e){}" +
      "document.querySelectorAll('video,audio').forEach(function(m){try{m.pause();}catch(e){}});})();"

  private val main = Handler(Looper.getMainLooper())
  private val views: MutableSet<ShieldWebView> = Collections.newSetFromMap(WeakHashMap())

  var onFired: (() -> Unit)? = null

  private val fire = Runnable {
    MediaPlaybackController.stop(pause = true)
    synchronized(views) { views.toList() }.forEach { it.pauseMedia() }
    onFired?.invoke()
  }

  fun register(view: ShieldWebView) = synchronized(views) { views.add(view) }

  fun unregister(view: ShieldWebView) = synchronized(views) { views.remove(view) }

  /** Pauses everything after [seconds]; null or 0 cancels. */
  fun set(seconds: Double?) {
    main.post {
      main.removeCallbacks(fire)
      if (seconds != null && seconds > 0) main.postDelayed(fire, (seconds * 1000).toLong())
    }
  }
}
