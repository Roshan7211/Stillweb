#!/usr/bin/env node
// Collects the license notices for everything Stillweb ships, for About › Open-source licenses:
// the npm packages that end up in the JavaScript bundle (found from the bundle's source maps),
// React Native's native libraries, the vendored page scripts, and the filter data.
//   node scripts/gen-licenses.mjs   (re-run after adding or upgrading dependencies or filter lists)
// Needs the network for license texts that aren't in node_modules.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'src/ui/licenses.generated.json');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'src/blocking/filter-catalog.json'), 'utf8'));
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.text()).replace(/\r\n/g, '\n');
}

// Full texts of the licenses that are long and shared by several components.
const LICENSE_TEXTS = {
  'GPL-3.0': `https://raw.githubusercontent.com/${catalog.resources.repo}/${catalog.resources.tag}/LICENSE.txt`,
  'CC-BY-SA-3.0': 'https://creativecommons.org/licenses/by-sa/3.0/legalcode.txt',
  'CC-BY-3.0': 'https://creativecommons.org/licenses/by/3.0/legalcode.txt',
  'MPL-2.0': 'node_modules/@duckduckgo/autoconsent/LICENSE',
  'Apache-2.0': 'https://www.apache.org/licenses/LICENSE-2.0.txt',
  'BSL-1.0': 'https://www.boost.org/LICENSE_1_0.txt',
};

// React Native's native libraries (versions from react-native/scripts/cocoapods/helpers.rb and
// third-party-podspecs). Short permissive licenses are shown in full with their copyright line.
const NATIVE = [
  { name: 'Hermes', license: 'MIT', url: 'https://raw.githubusercontent.com/facebook/hermes/main/LICENSE' },
  { name: 'Folly 2024.11.18.00', license: 'Apache-2.0', notice: 'Copyright (c) Meta Platforms, Inc. and affiliates.' },
  { name: 'glog 0.3.5', license: 'BSD-3-Clause', url: 'https://raw.githubusercontent.com/google/glog/v0.3.5/COPYING' },
  { name: 'double-conversion 1.1.6', license: 'BSD-3-Clause', url: 'https://raw.githubusercontent.com/google/double-conversion/v1.1.6/LICENSE' },
  { name: '{fmt} 12.1.0', license: 'MIT', url: 'https://raw.githubusercontent.com/fmtlib/fmt/12.1.0/LICENSE' },
  { name: 'fast_float 8.0.0', license: 'MIT', url: 'https://raw.githubusercontent.com/fastfloat/fast_float/v8.0.0/LICENSE-MIT' },
  { name: 'Boost 1.84.0', license: 'BSL-1.0', notice: 'Distributed under the Boost Software License, Version 1.0.' },
  { name: 'SocketRocket 0.7.1', license: 'BSD-3-Clause', url: 'https://raw.githubusercontent.com/facebookincubator/SocketRocket/0.7.1/LICENSE' },
  { name: 'Feather icons', license: 'MIT', url: 'https://raw.githubusercontent.com/feathericons/feather/main/LICENSE' },
];

/** npm packages in the iOS and Android JavaScript bundles, with the folder each was read from. */
function bundledPackages() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stillweb-licenses-'));
  const found = new Map();
  try {
    for (const platform of ['ios', 'android']) {
      const outDir = path.join(tmp, platform);
      execFileSync('npx', ['expo', 'export', '--platform', platform, '--source-maps', '--output-dir', outDir], {
        cwd: root,
        stdio: ['ignore', 'ignore', 'inherit'],
      });
      const maps = [];
      const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name.endsWith('.map')) maps.push(p);
        }
      };
      walk(outDir);
      for (const map of maps) {
        for (const source of JSON.parse(fs.readFileSync(map, 'utf8')).sources) {
          const at = source.lastIndexOf('node_modules/');
          if (at < 0) continue;
          const parts = source.slice(at + 'node_modules/'.length).split('/');
          const name = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
          // Sources are project-relative, written with a leading slash ("/node_modules/…").
          const dir = path.join(root, source.slice(0, at + 'node_modules/'.length) + name);
          if (!found.has(name) && fs.existsSync(path.join(dir, 'package.json'))) found.set(name, dir);
        }
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return found;
}

function licenseFile(dir) {
  const file = fs.readdirSync(dir).find((n) => /^(licen[sc]e|copying)(\.(md|txt))?$/i.test(n));
  return file ? fs.readFileSync(path.join(dir, file), 'utf8').replace(/\r\n/g, '\n').trim() : null;
}

const texts = {};
for (const [id, src] of Object.entries(LICENSE_TEXTS)) {
  texts[id] = (src.startsWith('https://') ? await fetchText(src) : read(src)).trim();
}

const components = [];

// Filter data and page scripts that are part of blocking.
for (const list of catalog.lists) {
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
for (const s of catalog.software) {
  components.push({
    name: s.title,
    license: s.license,
    text: `Licensed under the Mozilla Public License 2.0; see MPL-2.0 below.\nSource: ${s.homepage}`,
  });
}
const readability = JSON.parse(read('node_modules/@mozilla/readability/package.json'));
components.push({
  name: `Readability ${readability.version}`,
  license: 'Apache-2.0',
  text: `${read('node_modules/@mozilla/readability/LICENSE.md').trim()}\n\nFull text: see Apache-2.0 below.`,
});

for (const n of NATIVE) {
  components.push({
    name: n.name,
    license: n.license,
    text: n.url ? (await fetchText(n.url)).trim() : `${n.notice}\nFull text: see ${n.license} below.`,
  });
}

const reactNativeLicense = licenseFile(path.join(root, 'node_modules/react-native'));
for (const [name, dir] of [...bundledPackages()].sort(([a], [b]) => a.localeCompare(b))) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  // Packages published from the React Native and Expo repos without their own copy.
  const text =
    licenseFile(dir) ??
    (name.startsWith('@react-native/') ? reactNativeLicense : null) ??
    (name.startsWith('@expo/') || name.startsWith('expo') ? licenseFile(path.join(root, 'node_modules/expo')) : null);
  if (!text) throw new Error(`${name}: no license file found in ${dir}`);
  components.push({ name: `${name} ${pkg.version}`, license: pkg.license ?? 'see text', text });
}

fs.writeFileSync(OUT, `${JSON.stringify({ components, texts }, null, 1)}\n`);
const kb = Math.round(fs.statSync(OUT).size / 1024);
console.log(`wrote ${path.relative(root, OUT)}: ${components.length} components, ${Object.keys(texts).length} license texts, ${kb} KB`);
