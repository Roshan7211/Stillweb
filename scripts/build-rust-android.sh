#!/usr/bin/env bash
# Cross-compiles the adblock-rust JNI library into the shield-webview module's jniLibs.
# Usage: scripts/build-rust-android.sh            (all ABIs)
#        ABIS="arm64-v8a" scripts/build-rust-android.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CRATE="$ROOT/native/shield-webview/rust"
OUT="$ROOT/native/shield-webview/android/src/main/jniLibs"
ABIS="${ABIS:-arm64-v8a armeabi-v7a x86_64}"

export PATH="$HOME/.cargo/bin:$PATH"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
if [[ -z "${ANDROID_NDK_HOME:-}" ]]; then
  ANDROID_NDK_HOME="$(ls -d "$ANDROID_HOME"/ndk/* 2>/dev/null | sort -V | tail -1)"
  export ANDROID_NDK_HOME
fi

command -v cargo-ndk >/dev/null || { echo "cargo-ndk missing: cargo install cargo-ndk" >&2; exit 1; }

# Skip the build when every requested .so is newer than the Rust sources.
newest_src="$(find "$CRATE/src" "$CRATE/Cargo.toml" -type f -newer "$OUT/.stamp" 2>/dev/null | head -1 || true)"
missing=0
for abi in $ABIS; do [[ -f "$OUT/$abi/libadblock_jni.so" ]] || missing=1; done
if [[ -f "$OUT/.stamp" && -z "$newest_src" && $missing -eq 0 ]]; then
  echo "adblock_jni is up to date"
  exit 0
fi

targets=()
for abi in $ABIS; do targets+=(-t "$abi"); done

cd "$CRATE"
cargo ndk "${targets[@]}" -P 24 -o "$OUT" build --release --lib
touch "$OUT/.stamp"
ls -la "$OUT"/*/libadblock_jni.so
