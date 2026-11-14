# Kept as they are when the app is shrunk with R8 (release builds).
# The Rust engine's JNI functions are named after AdblockNative, page scripts call
# @JavascriptInterface methods by name, and the Expo module system finds modules by class.
-keep class expo.modules.shieldwebview.** { *; }
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
