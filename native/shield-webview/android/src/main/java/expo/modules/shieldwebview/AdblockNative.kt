package expo.modules.shieldwebview

/** JNI bindings for native/shield-webview/rust (libadblock_jni.so). */
internal object AdblockNative {
  const val ALLOW = 0
  const val BLOCK = 1
  const val REDIRECT = 2

  init {
    System.loadLibrary("adblock_jni")
  }

  /** Builds an engine from filter list files; returns 0 on failure. */
  @JvmStatic external fun nativeCreate(paths: Array<String>, trusted: BooleanArray): Long

  @JvmStatic external fun nativeDeserialize(data: ByteArray): Long

  @JvmStatic external fun nativeSerialize(handle: Long): ByteArray?

  /** Loads scriptlet/redirect resources (JSON file); returns the count or -1. */
  @JvmStatic external fun nativeUseResources(handle: Long, path: String): Int

  /** Returns ALLOW, BLOCK or REDIRECT; for REDIRECT, redirectOut[0] holds a data: URL. */
  @JvmStatic external fun nativeCheck(
    handle: Long,
    url: String,
    sourceUrl: String,
    requestType: String,
    redirectOut: Array<String?>
  ): Int

  /** JSON of adblock-rust's UrlSpecificResources for the URL's hostname. */
  @JvmStatic external fun nativeCosmetic(handle: Long, url: String): String

  /** Takes {"classes","ids","exceptions"} JSON, returns a JSON array of selectors. */
  @JvmStatic external fun nativeHiddenSelectors(handle: Long, queryJson: String): String

  @JvmStatic external fun nativeDestroy(handle: Long): Boolean
}
