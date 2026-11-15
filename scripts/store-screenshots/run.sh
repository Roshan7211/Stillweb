#!/bin/bash
# Builds Stillweb for the simulator and takes App Store screenshots on an iPhone Pro Max
# (1320x2868) and an iPad Pro 13-inch (2064x2752) with Maestro. Output: out/<device>/*.png
set -uo pipefail
cd "$(dirname "$0")/../.."
ROOT=$(pwd)
mkdir -p out

XCODE=$(ls -d /Applications/Xcode_*.app 2>/dev/null | sort -V | tail -1)
echo "== Xcode: $XCODE"
sudo xcode-select -s "$XCODE/Contents/Developer"
xcodebuild -version

echo "== Build"
npm ci --no-audit --no-fund
npx expo prebuild --platform ios --clean
xcodebuild -workspace ios/Stillweb.xcworkspace -scheme Stillweb -configuration Release \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath build \
  CODE_SIGNING_ALLOWED=NO -quiet || { echo "BUILD FAILED"; exit 1; }
APP=$(ls -d build/Build/Products/Release-iphonesimulator/*.app | head -1)
echo "== App: $APP"

echo "== Maestro"
curl -fsSL "https://get.maestro.mobile.dev" | bash
export PATH="$HOME/.maestro/bin:$PATH"
maestro --version

RUNTIME=$(xcrun simctl list runtimes -j | python3 -c "import json,sys; r=[x for x in json.load(sys.stdin)['runtimes'] if x['isAvailable'] and x['platform']=='iOS']; print(sorted(r,key=lambda x:[int(p) for p in x['version'].split('.')])[-1]['identifier'])")
echo "== Runtime: $RUNTIME"
pick() { xcrun simctl list devicetypes | grep -E "$1" | sed -E 's/.*\((com\.apple[^)]*)\).*/\1/' | sort -V | tail -1; }

shoot() {
  local name=$1 type=$2
  echo "== $name ($type)"
  local udid
  udid=$(xcrun simctl create "Store $name" "$type" "$RUNTIME")
  xcrun simctl boot "$udid"
  xcrun simctl bootstatus "$udid" -b
  xcrun simctl status_bar "$udid" override --time "9:41" --dataNetwork wifi --wifiMode active --wifiBars 3 \
    --cellularMode active --cellularBars 4 --batteryState charged --batteryLevel 100
  xcrun simctl ui "$udid" appearance light
  xcrun simctl install "$udid" "$APP"
  mkdir -p "out/$name"
  (cd "out/$name" && maestro --device "$udid" test "$ROOT/scripts/store-screenshots/flow.yaml") || echo "flow ended early on $name"
  # The last screen, whatever happened.
  xcrun simctl io "$udid" screenshot "out/$name/zz-last.png" || true
  find "out/$name" -name "*.png" -exec mv {} "out/$name/" \; 2>/dev/null
  xcrun simctl shutdown "$udid" || true
}

shoot iphone "$(pick 'iPhone 1[6-9] Pro Max')"
shoot ipad "$(pick 'iPad Pro 13-inch')"
ls -R out
