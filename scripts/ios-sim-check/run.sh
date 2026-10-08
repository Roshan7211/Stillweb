#!/bin/bash
# Builds the app's native web view code (ShieldWebView.swift, ShieldEngine.swift) into a small
# test app, runs it in an iOS simulator against real sites and prints what each page got on its
# first load and after the user's reload. Everything goes to stdout; screenshots to shots/.
set -u
cd "$(dirname "$0")/../.."
HERE=scripts/ios-sim-check
OUT=build/ios-sim-check
rm -rf "$OUT" shots && mkdir -p "$OUT/src" "$OUT/Test.app" shots

echo "== machine"
sw_vers
uname -m
ls /Applications | grep -i xcode || true

# The newest released Xcode on the machine (its simulator has the newest iOS).
XCODE=$(ls -d /Applications/Xcode_*.app 2>/dev/null | grep -vi beta | grep -vi "release_candidate" | sort -V | tail -1)
if [ -n "${XCODE:-}" ]; then sudo xcode-select -s "$XCODE" || true; fi
xcodebuild -version
xcrun simctl list runtimes

RUNTIME=$(xcrun simctl list runtimes -j | python3 -c '
import json, sys
runtimes = [r for r in json.load(sys.stdin)["runtimes"] if r.get("isAvailable") and r.get("platform", "iOS") == "iOS" and r["identifier"].split(".")[-1].startswith("iOS")]
runtimes.sort(key=lambda r: [int(p) for p in r["version"].split(".")])
print(runtimes[-1]["identifier"] if runtimes else "")')
DEVICE_TYPE=$(xcrun simctl list devicetypes -j | python3 -c '
import json, sys, re
types = [t for t in json.load(sys.stdin)["devicetypes"] if t["name"].startswith("iPhone") and re.search(r"iPhone \d+$", t["name"])]
types.sort(key=lambda t: int(t["name"].split()[-1]))
print(types[-1]["identifier"] if types else "com.apple.CoreSimulator.SimDeviceType.iPhone-16")')
echo "== runtime $RUNTIME, device $DEVICE_TYPE"
[ -n "$RUNTIME" ] || { echo "no iOS simulator runtime on this machine"; exit 1; }

# Builds the test app from the native sources of a commit (or of the checkout: "tree"), and
# installs it once the simulator is there.
build() {
  local ref=$1
  echo "== build ($ref)"
  rm -rf "$OUT/src" "$OUT/Test.app" && mkdir -p "$OUT/src" "$OUT/Test.app"
  for f in ShieldWebView.swift ShieldEngine.swift; do
    if [ "$ref" = tree ]; then cp "native/shield-webview/ios/$f" "$OUT/src/$f.in"
    else git show "$ref:native/shield-webview/ios/$f" > "$OUT/src/$f.in"; fi
  done
  python3 "$HERE/prepare.py" "$OUT/src" || exit 1
  local arch sdk
  arch=$(uname -m)
  sdk=$(xcrun --sdk iphonesimulator --show-sdk-path)
  xcrun -sdk iphonesimulator swiftc -O -module-name Test \
    -target "${arch}-apple-ios17.0-simulator" -sdk "$sdk" \
    "$HERE/Stubs.swift" "$OUT/src/ShieldWebView.swift" "$OUT/src/ShieldEngine.swift" "$HERE/main.swift" \
    -o "$OUT/Test.app/Test" 2>&1 | grep -v "warning:" | head -60
  [ -x "$OUT/Test.app/Test" ] || { echo "build failed"; exit 1; }
  cp "$HERE/Info.plist" "$OUT/Test.app/Info.plist"
  mkdir -p "$OUT/Test.app/ShieldWebViewAssets.bundle"
  cp -R native/shield-webview/ios/Resources/shield "$OUT/Test.app/ShieldWebViewAssets.bundle/shield"
  cp native/shield-webview/ios/Resources/vendor/autoconsent.js "$OUT/Test.app/ShieldWebViewAssets.bundle/autoconsent.js"
  codesign -s - --force "$OUT/Test.app" 2>&1 | tail -1
  if [ -n "${UDID:-}" ]; then xcrun simctl install "$UDID" "$OUT/Test.app" || { echo "install failed"; exit 1; }; fi
}
UDID=
build "${BEFORE:-tree}"

echo "== simulator"
UDID=$(xcrun simctl create stillweb-check "$DEVICE_TYPE" "$RUNTIME")
echo "device $UDID"
xcrun simctl boot "$UDID"
xcrun simctl bootstatus "$UDID" -b | tail -2
xcrun simctl install "$UDID" "$OUT/Test.app" || { echo "install failed"; exit 1; }

run() {
  local name=$1; shift
  echo
  echo "================ $name: $*"
  xcrun simctl launch --console-pty "$UDID" app.stillweb.nativetest "$@" 2>&1 | while IFS= read -r line; do
    line=${line%$'\r'}
    echo "$line"
    case "$line" in
      *"SHOT "*) xcrun simctl io "$UDID" screenshot "shots/$name-${line##*SHOT }.png" >/dev/null 2>&1 ;;
    esac
  done
  xcrun simctl terminate "$UDID" app.stillweb.nativetest >/dev/null 2>&1 || true
}

if [ $# -gt 0 ]; then
  run custom "$@"
else
  # A tab whose page process iOS ended while it was hidden, opened again: before the fix
  # (BEFORE, a commit) and with the code of this checkout.
  if [ -n "${BEFORE:-}" ]; then
    run before-video-plain "https://youtube.com/" kill
    run before-video-typed "https://youtube.com/" via-bar kill
    run before-news "https://www.cnn.com/" kill
    build tree
  fi
  run video-plain "https://youtube.com/" kill
  run video-typed "https://youtube.com/" via-bar kill
  run video-watch "https://www.youtube.com/watch?v=kJQP7kiw5Fk" kill
  run music "https://music.youtube.com/" kill
  run news "https://www.cnn.com/" kill
fi

# Smaller pictures: they are only looked at, and are kept in the repository's results branch.
for f in shots/*.png; do
  [ -f "$f" ] || continue
  sips -Z 1100 -s format jpeg -s formatOptions 60 "$f" --out "${f%.png}.jpg" >/dev/null 2>&1 && rm "$f"
done
xcrun simctl shutdown "$UDID" >/dev/null 2>&1 || true
xcrun simctl delete "$UDID" >/dev/null 2>&1 || true
echo "== finished"
