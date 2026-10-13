This is an Expo/React Native mobile application. Prioritize mobile-first patterns, performance, and cross-platform compatibility.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt — an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Commands

Use `bunx` instead of `npx` if the project uses bun (`bun.lock` present).

```bash
npx expo install <package>  # ALWAYS use instead of npm/yarn/pnpm/bun add — resolves SDK-compatible versions
npx expo start              # start the dev server
npx expo lint               # lint
npx tsc --noEmit            # typecheck
npx expo-doctor             # diagnose dependency and config issues
npx expo install --fix      # fix incompatible package versions
```

Run lint and typecheck before declaring any task done.

## Project layout

- `native/shield-webview/` — local Expo module: the ad-blocking WebView (Kotlin + Swift), the adblock-rust JNI crate (`rust/`), and page scripts shared by both platforms (`web/shieldjs/`).
- `src/blocking/` — filter catalog, update checks, dev proxy. `src/browser/` — tabs, settings, library, URL/search, reader. `src/ui/` — screens and components.
- No Expo Router: the app is a single browser screen with overlay screens (`src/ui/screens/BrowserScreen.tsx`).
- Never use brand names (for example video sites) in the app name, UI text or store assets. Credit filter list licenses in `AboutScreen`.
- After changing Rust: `npm run build:rust:android`. After changing filter lists or the catalog: `npm run build:filters -- --bundle`.
- After adding or upgrading dependencies, vendored scripts or filter lists: `npm run build:licenses` (About › Open-source licenses must list everything the app ships).
- `desktop/` — the Windows and Mac app (Electron), a separate package with its own `package.json`: run npm commands inside it, never `expo install`. `src/main/` is the main process (windows, tabs, blocking in `shields.ts`), `src/preload/` runs in pages and in the window's interface, `src/renderer/` is the interface (React). It reuses the Rust engine compiled to WebAssembly (`desktop/resources/engine.wasm`), the Android filter bundle, the page scripts in `web/shieldjs/`, and the plain TypeScript in `src/browser/` (`url.ts`, `suggestEndpoints.ts`, `loadErrors.ts`): keep those free of React Native imports.
- After changing Rust, also rebuild the desktop engine: `npm run build:engine` in `desktop/`. `npm run build:filters -- --bundle` also writes the desktop app's `resources/shield-delta.json` (`--bundle-desktop` writes only that).
- After changing anything the desktop app uses: `npm run typecheck` and `npm test` in `desktop/`. The test runs the real app against a local web server and must pass; it opens windows on screen. `npm run dist:mac` / `npm run dist:win` build the installers (both work from a Mac).
- After changing iOS background playback (`backgroundPlayScript` in `ios/ShieldWebView.swift`): `npm run test:background-play`. It simulates how WebKit pauses and resumes media on iOS; add a scenario for every behavior you change.

## Building with EAS

Use EAS to build, sign, and submit the app in the cloud (`eas build`, `eas submit`) and to ship over-the-air updates (`eas update`) — no local Xcode or Android Studio required. Run EAS CLI as `bunx eas-cli <command>` in Bun projects, or `npx eas-cli@latest <command>` otherwise; substitute that for bare `eas` in docs examples.
Docs: https://docs.expo.dev/eas/index.md

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build: `npx expo run:ios|android` locally, or `eas build --profile development`.
- Prefer recommended Expo modules over third-party libraries, and check your available skills before adding dependencies. Docs: https://docs.expo.dev/versions/latest/index.md
