#!/usr/bin/env node
// Bundles the desktop app into build/: the main process, the two preload scripts and the
// window's interface.   node scripts/build.mjs [--production]
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(DESKTOP, '..');
const OUT = path.join(DESKTOP, 'build');
const production = process.argv.includes('--production');

/** `import text from './file.js?text'`: the file's contents as a string. */
const textFiles = {
  name: 'text-files',
  setup(b) {
    b.onResolve({ filter: /\?text$/ }, (args) => ({
      path: path.resolve(args.resolveDir, args.path.slice(0, -'?text'.length)),
      namespace: 'text-file',
    }));
    b.onLoad({ filter: /.*/, namespace: 'text-file' }, (args) => ({
      contents: fs.readFileSync(args.path, 'utf8'),
      loader: 'text',
      watchFiles: [args.path],
    }));
  },
};

const common = {
  bundle: true,
  minify: production,
  sourcemap: production ? false : 'inline',
  logLevel: 'warning',
  metafile: true,
  plugins: [textFiles],
  define: {
    'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development'),
    // Where the app looks for newer filters (the manifest.json published by the Filters
    // workflow). Unset: the app keeps the filters it shipped with.
    'process.env.STILLWEB_FILTER_MANIFEST_URL': JSON.stringify(process.env.STILLWEB_FILTER_MANIFEST_URL ?? ''),
  },
};

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'renderer'), { recursive: true });

const results = await Promise.all([
  build({
    ...common,
    entryPoints: [path.join(DESKTOP, 'src/main/main.ts')],
    outfile: path.join(OUT, 'main.js'),
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
  }),
  build({
    ...common,
    entryPoints: [path.join(DESKTOP, 'src/preload/page.ts')],
    outfile: path.join(OUT, 'preload-page.js'),
    // Sandboxed preload scripts are plain scripts with a `require` that only knows 'electron'.
    platform: 'browser',
    format: 'cjs',
    target: 'chrome140',
    external: ['electron'],
    // No source map here: this script runs in every frame of every page.
    sourcemap: false,
    define: {
      ...common.define,
      // web/shieldjs/cosmetic-host.js ends with this placeholder; see src/preload/frameStart.ts.
      __SHIELD_CONFIG__: 'globalThis.__stillwebHostConfig',
    },
  }),
  build({
    ...common,
    entryPoints: [path.join(DESKTOP, 'src/preload/chrome.ts')],
    outfile: path.join(OUT, 'preload-chrome.js'),
    platform: 'browser',
    format: 'cjs',
    target: 'chrome140',
    external: ['electron'],
  }),
  build({
    ...common,
    entryPoints: [path.join(DESKTOP, 'src/renderer/index.tsx')],
    outfile: path.join(OUT, 'renderer/index.js'),
    platform: 'browser',
    format: 'iife',
    target: 'chrome140',
    jsx: 'automatic',
    loader: { '.png': 'dataurl', '.svg': 'text' },
  }),
]);

fs.copyFileSync(path.join(DESKTOP, 'src/renderer/index.html'), path.join(OUT, 'renderer/index.html'));

// ---------------------------------------------------------------------------
// About › Open-source licenses: everything this app ships.

function licenseFile(dir) {
  const file = fs.readdirSync(dir).find((n) => /^(licen[sc]e|copying)(\.(md|txt))?$/i.test(n));
  return file ? fs.readFileSync(path.join(dir, file), 'utf8').replace(/\r\n/g, '\n').trim() : null;
}

const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/blocking/filter-catalog.json'), 'utf8'));
// The long shared license texts are collected by the mobile app's `npm run build:licenses`.
const shared = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/ui/licenses.generated.json'), 'utf8'));
const components = [];
for (const list of catalog.lists.filter((l) => l.group !== 'calm')) {
  components.push({
    name: list.title,
    license: list.license,
    text: `${list.title}\nUsed under ${list.license}. Distributed unmodified apart from automated format conversion.\nSource and license: ${list.licenseUrl}`,
  });
}
components.push({
  name: `${catalog.resources.title} ${catalog.resources.tag}`,
  license: catalog.resources.license,
  text: `Copyright (C) Raymond Hill and contributors.\nLicensed under the GNU General Public License v3; see GPL-3.0 below.\nSource: ${catalog.resources.homepage}/tree/${catalog.resources.tag}`,
});
const adblock = catalog.software.find((s) => s.title === 'adblock-rust');
components.push({
  name: adblock.title,
  license: adblock.license,
  text: `Licensed under the Mozilla Public License 2.0; see MPL-2.0 below.\nSource: ${adblock.homepage}`,
});
const electron = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'node_modules/electron/package.json'), 'utf8'));
components.push({
  name: `Electron ${electron.version}`,
  license: 'MIT',
  text: `${licenseFile(path.join(DESKTOP, 'node_modules/electron'))}\n\nElectron includes Chromium, Node.js and their libraries; their notices are in the file LICENSES.chromium.html that ships with the app (About › Chromium and its libraries).`,
});

const packages = new Map();
for (const result of results) {
  for (const input of Object.keys(result.metafile.inputs)) {
    const at = input.lastIndexOf('node_modules/');
    if (at < 0) continue;
    const parts = input.slice(at + 'node_modules/'.length).split('/');
    const name = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
    const dir = path.resolve(DESKTOP, input.slice(0, at + 'node_modules/'.length) + name);
    if (!packages.has(name) && fs.existsSync(path.join(dir, 'package.json'))) packages.set(name, dir);
  }
}
for (const [name, dir] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const text = licenseFile(dir);
  if (!text) throw new Error(`[build] no license file for ${name}: add one to the About list by hand`);
  components.push({ name: `${name} ${pkg.version}`, license: pkg.license ?? '', text });
}
const used = ['GPL-3.0', 'CC-BY-SA-3.0', 'CC-BY-3.0', 'MPL-2.0'];
const texts = Object.fromEntries(used.map((id) => [id, shared.texts[id]]));
fs.writeFileSync(path.join(OUT, 'licenses.json'), JSON.stringify({ components, texts }));

console.log(`[build] build/ ready (${production ? 'production' : 'development'}, ${components.length} license entries)`);
