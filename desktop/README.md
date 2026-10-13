# Stillweb for Windows and Mac

The desktop app: a Chromium browser (Electron) with the same blocking as the mobile apps.

```bash
npm install
npm start          # build and open the app
npm test           # build, then run the app against a local web server and check it
npm run test:live  # open a real page with a fresh profile and report what was blocked
npm run typecheck
npm run dist:mac   # installers in dist/ (dmg and zip, Intel and Apple silicon)
npm run dist:win   # installer in dist/ (works from a Mac too)
```

## What it shares with the mobile apps

- The engine: `native/shield-webview/rust`, compiled to WebAssembly (`resources/engine.wasm`,
  committed; `npm run build:engine` after changing the Rust code). One file serves every
  platform, so there is nothing to compile per system.
- The filters: the Android bundle in `native/shield-webview/android/src/main/assets/shield`,
  plus `resources/shield-delta.json`, the few lines that differ on a computer. Updates come
  from the same published bundle (`STILLWEB_FILTER_MANIFEST_URL` at build time; unset, the app
  keeps the filters it shipped with).
- The page scripts in `native/shield-webview/web/shieldjs` and the plain TypeScript in
  `src/browser` (addresses and search, suggestions, error descriptions).

## When a site still shows ads

`node scripts/run.mjs --log-shields` prints every blocked request, every window a page
tries to open and why it was let through or stopped, and every navigation. Two things then
help:

- `resources/stillweb-fixes.txt` is the app's own small filter list (same syntax as the
  others, shown in Settings as "Stillweb fixes"). Put a rule there when the shared lists
  miss something, with the address and date it was tested on.
- Pop-ups: on a page where a video is being watched or sound is playing, a press that is
  not on a real link cannot open another site (`popupDecision` in `src/main/shields.ts`).
  What was stopped shows in the address bar, and can be opened or allowed per site from the
  shield button.

## Home page photos

`resources/wallpapers/` holds the photos the home page shows, a small preview of each in
`thumbs/`, and `credits.json`: who took each one, its page, and the licence. A photo may
only be added with its entry there, after checking on its page that the licence allows
shipping it; the credit is shown on the home page and in About › Open-source licenses.

## How it is put together

- `src/main/` — the main process. `browserWindow.ts` is a window: one web view for the bars
  and one per tab. `shields.ts` checks every request and answers each frame's question about
  its cosmetic filters and scriptlets. `engine/` owns the engine and its filter bundles.
- `src/preload/page.ts` — runs in every frame of every page, before the page's own scripts.
- `src/renderer/` — the window's interface (React). It talks to the main process only
  through `window.stillweb` (`src/shared/types.ts`, `ChromeApi`).

The interface is drawn in its own layer above the page. It is as tall as the bars, and grows
to the whole window (transparent where it draws nothing) while a panel, a list or a new tab
page is showing.

## Not done yet

- Installers are signed ad-hoc (Mac) or not at all (Windows), so both systems warn before the
  first launch. Signing needs a Developer ID certificate and a Windows code-signing certificate.
- No automatic app updates, and the app does not register itself as the default browser.
- Video that needs DRM does not play: Electron ships without the module for it.
- Stillweb Plus (Calm Mode, profiles, the vault) is not part of the desktop app.
