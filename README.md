# Stillweb

A private, ad-blocking browser for iOS and Android built with React Native (Expo, TypeScript). Bundle ID / package: `app.stillweb.browser`.

## How blocking works

| | Android | iOS |
|---|---|---|
| Network blocking | Every subresource request is checked in `shouldInterceptRequest` against Brave's adblock-rust (via JNI). Blocked requests fail with a network error, as with a browser extension. | EasyList/EasyPrivacy/uBO lists are compiled to `WKContentRuleList`s and attached to `WKWebView`. |
| Element hiding | Host-specific rules + procedural filters injected at document start; generic `##.ad` rules resolved live through a message bridge. | `css-display-none` rules inside the content rule lists. |
| Scriptlets (inline video ads, anti-adblock) | uBlock Origin scriptlets via adblock-rust, injected per host at document start. | Same scriptlets, precomputed per host into `scriptlets.json`, injected as `WKUserScript`s. |
| Blocked counter | Exact | Estimate (counts failed resource loads; WebKit doesn't report blocks) |
| Private tabs | Separate WebView profile (cookies/storage isolated) where the device supports it | Non-persistent data store |

## Privacy

- Blocking, history, bookmarks and settings stay on the device. The app has no accounts, analytics or crash reporting, and makes no network requests of its own except filter-list updates (when configured).
- Android WebView usage metrics are opted out (`android.webkit.WebView.MetricsOptOut`).
- Every page receives the Global Privacy Control signal (`navigator.globalPrivacyControl` and `Sec-GPC: 1` on navigations).
- Cross-site (third-party) cookies are blocked by default; connections are upgraded to HTTPS, with a fallback when a site has no HTTPS or redirects back to HTTP.
- Google is the default search engine (DuckDuckGo, Brave Search, Startpage, Ecosia, Bing or a custom engine can be chosen); search suggestions are local only (bookmarks and history), so typing never leaves the device.
- Private tabs: separate cookie/storage profile, never saved to history or restored, wiped when the last private tab closes and again at every launch, hidden from screenshots and the recent-apps preview (`FLAG_SECURE`), optionally locked with fingerprint or screen lock.
- "Clear data on exit" wipes cookies, cache, history and tabs at each fresh start.
- Google Safe Browsing (WebView's phishing/malware check, which uses hashed URL prefixes) is left on for security.

### App Store privacy

- **Privacy policy:** `site/privacy/index.html`, published by the filters workflow at `https://<user>.github.io/<repo>/privacy/` (set `EXPO_PUBLIC_PRIVACY_POLICY_URL` to link it from the About screen).
- **App Privacy label (App Store Connect):** "Data Not Collected"; tracking: No.
- **Privacy manifest:** `ios.privacyManifests` in `app.json` (no tracking, no collected data types, required-reason APIs taken from the dependencies' own manifests).
- **Export compliance:** `ios.config.usesNonExemptEncryption: false` (the app only uses the operating system's HTTPS), so App Store Connect won't ask for encryption documentation.

Measured on an OPPO CPH2119 (Android 12) with [adblock.turtlecute.org](https://adblock.turtlecute.org/), the maintained successor of d3ward's archived test: **89%** with shields on, **7%** with shields off.

## Background play (core feature)

Music, video and radio keep playing when the app is in the background or the screen is off, including moving on to the next track or video. Settings › Media › Play in background (on by default). Any change to the web view, settings or lifecycle must be re-tested against this.

**Android, how it works**
- Pages are told they stay visible (`web/shieldjs/background-play.js`), and the tab that owns playback keeps its WebView "visible" to Chromium, which otherwise pauses hidden media.
- A `mediaPlayback` foreground service with a MediaSession shows a notification (previous / play-pause / next / close). Headset, Bluetooth and lock-screen media keys work too.
- While audio plays, the service holds a Wi-Fi lock and a partial wake lock so streams keep buffering with the screen off. Both are released when playback pauses.
- The session survives gaps (track changes, buffering, short pauses) for 10 minutes. Android only allows a media service to *start* while the app is in the foreground, so a service stopped in the background could not come back for the next track.
- Once the user has started media on a site, autoplay is allowed there (`mediaPlaybackRequiresUserGesture = false`), so the next song or video starts without a tap. Leaving the site restores the tap requirement.
- `web/shieldjs/media.js` reports playback state, including players created in code that are never added to the page (`new Audio()` on radio and podcast sites). It provides a Media Session API, which Android WebView lacks, so sites publish the track title, artist and next/previous handlers.
- On YouTube and YouTube Music, the inactivity timer behind "Video paused. Continue watching?" / "Still listening?" is kept fresh, and the dialog is confirmed if it still appears.
- Private tabs show "Private tab" instead of the title, and never on the lock screen. Starting media in another tab pauses the first. Swiping the app away stops playback.
- **Notification:** square artwork (high-resolution covers from YouTube, otherwise the site's artwork or icon), title, artist (or the site), and the site name in the header. There's a seek bar for media with a known length. Buttons adapt: previous/next on playlist sites, ±10 s on single videos and podcasts, play/pause only for live radio, plus Close. Icons are crisp vectors in the app's accent colour. Private tabs never load artwork.

**Tested on the phone (release build, screen off)**
- YouTube Music: 6+ minutes locked, played a track to the end and moved on to the next by itself. Media keys skipped tracks while locked.
- YouTube: the next video autoplayed with the screen off and kept playing.
- SomaFM internet radio (a player not in the page): 60 s screen off, live track title in the notification.
- Notification pause, play and next all work.

**iOS:** `UIBackgroundModes: audio`, an `AVAudioSession` playback category and the same visibility script. Not yet tested on a device.

## Layout

```
native/shield-webview/   Local Expo module (autolinked via package.json "nativeModulesDir")
  android/               Kotlin: ShieldWebView, ShieldEngine (engine lifecycle, updates), JNI bindings
  ios/                   Swift: ShieldWebView (WKWebView), ShieldEngine (rule lists, scriptlets)
  rust/                  adblock-rust JNI wrapper + filter-compiler (iOS rule/scriptlet builder)
  web/shieldjs/          Page scripts shared by both platforms
src/blocking/            Filter catalog (lists + licenses), daily updater, dev proxy
src/browser/             Tabs, settings, bookmarks/history/downloads, URL/search, reader view
src/ui/                  Screens and components
scripts/                 Rust build, filter pipeline, Readability embedding
.github/workflows/       Daily filter build published to GitHub Pages
```

## Features

Tabs and private tabs, address bar with search (Google default, changeable), background play for music and video with a media notification, fullscreen video that rotates to landscape, friendly error pages (offline, site not found, certificate problems), landscape and tablet layouts, per-site protection toggle with blocked counters, bookmarks, history, downloads, reader view, find in page, share, long-press menu for links and images (open in new/private tab, copy, share, download), file uploads, pop-up and redirect blocking, cookie-banner hiding, light/dark/automatic theme with darkened pages, text size, default-browser support (opens links from other apps), clear data on exit, and an About screen crediting every filter list license.

## Run on Android

Requirements: Node, JDK 17, Android SDK/NDK, Rust (`rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android`, `cargo install cargo-ndk`).

```sh
npm install
npm run build:rust:android     # builds libadblock_jni.so for all ABIs
npm run android                # prebuild + build + install + start Metro
```

`ANDROID_HOME` must point at the Android SDK (prebuild regenerates `android/` and drops `local.properties`).

Standalone release APK (no dev server needed; signed with the debug key, fine for sideloading):

```sh
cd android && ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a,armeabi-v7a
# -> android/app/build/outputs/apk/release/app-release.apk
```

For Google Play, create an upload key and configure release signing first.

If the phone has no internet of its own, debug builds can route web traffic through your computer: run any HTTP proxy on port 8899, `adb reverse tcp:8899 tcp:8899`, and set `EXPO_PUBLIC_DEV_PROXY=127.0.0.1:8899` in `.env.local`.

## Run on iOS

Not yet built or tested on a device. Needs Xcode and CocoaPods: `npx expo run:ios`. The Swift module compiles the bundled rule lists on first launch (a few seconds) and caches them.

## Filter lists and updates

`npm run build:filters -- --bundle` downloads the lists in `src/blocking/filter-catalog.json`, resolves `!#include`/`!#if` per platform, converts uBlock Origin's scriptlets, compiles the iOS rule lists, writes `filter-server/dist/manifest.json` (with SHA-256 per file), and copies the result into the app as the offline default.

To get updates without app releases:
1. Push this project to GitHub and enable Pages (Settings → Pages → Source: GitHub Actions).
2. `.github/workflows/filters.yml` rebuilds and publishes the bundle daily.
3. Set `EXPO_PUBLIC_FILTER_MANIFEST_URL=https://<user>.github.io/<repo>/manifest.json` and rebuild the app.

The app checks at launch, when it returns to the foreground, and in a daily background task; native code verifies checksums before switching filters. Without a manifest URL the app keeps using its built-in filters.

## App icon

`assets/source/stillweb-icon.svg` (full icon) and `stillweb-glyph.svg` (shield glyph) are the masters. `python3 scripts/gen-icons.py` renders every size (iOS icon without alpha, Android adaptive layers, splash, favicon) on macOS.

## Licenses

Filter lists: EasyList and EasyPrivacy (GPLv3 / CC BY-SA 3.0), EasyList Cookie List (CC BY 3.0), uBlock filters (GPLv3), AdGuard DNS filter (GPLv3, Android only). Scriptlets: uBlock Origin (GPLv3). Engine: adblock-rust (MPL-2.0). Reader view: Mozilla Readability (Apache-2.0). All are credited in the in-app About screen.
