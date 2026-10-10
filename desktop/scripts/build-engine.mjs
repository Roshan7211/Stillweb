#!/usr/bin/env node
// Compiles the adblock-rust wrapper (native/shield-webview/rust) to WebAssembly for the desktop
// app. One file serves Windows and Mac; it is committed (resources/engine.wasm), so building the
// app needs no Rust toolchain. Run after changing the Rust code:
//   npm run build:engine     (needs: rustup target add wasm32-unknown-unknown)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE = path.resolve(DESKTOP, '../native/shield-webview/rust');
const TARGET = 'wasm32-unknown-unknown';

const home = path.join(os.homedir(), '.cargo/bin/cargo');
execFileSync(fs.existsSync(home) ? home : 'cargo', ['build', '--release', '--target', TARGET, '--lib'], {
  cwd: CRATE,
  stdio: 'inherit',
});
const built = path.join(CRATE, 'target', TARGET, 'release/adblock_jni.wasm');
const out = path.join(DESKTOP, 'resources/engine.wasm');
fs.copyFileSync(built, out);
console.log(`[engine] ${path.relative(DESKTOP, out)} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
