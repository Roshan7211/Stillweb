#!/usr/bin/env node
// Builds the filter bundle that the app downloads (and ships as its offline default).
//
//   node scripts/filters/build.mjs [--out filter-server/dist] [--bundle] [--skip-ios]
//
// Output layout (all paths in manifest.json are relative to manifest.json):
//   manifest.json
//   android/<list-id>.txt   lists preprocessed for Chromium/mobile, consumed by adblock-rust
//   resources.json          uBO scriptlets + redirect resources in adblock-rust's format
//   ios/rules-*.json        WKContentRuleList JSON (built by the Rust filter-compiler)
//   ios/scriptlets.json     per-host scriptlet injections for WKUserScript
//   desktop/delta.json      the lines that differ on a computer (the desktop app uses the
//                           android lists and resources.json, with these lines swapped)
//
// --bundle copies the result into the native module (and the desktop app) so the apps work
// offline on first launch. --bundle-desktop copies only the desktop app's part.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/blocking/filter-catalog.json'), 'utf8'));

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};

const OUT = path.resolve(ROOT, option('--out', 'filter-server/dist'));
const CACHE = path.join(ROOT, 'scripts/filters/.cache');
const MODULE = path.join(ROOT, 'native/shield-webview');

// `!#if` tokens that are true per platform; anything not listed evaluates to false.
const PLATFORM_ENV = {
  android: new Set(['env_chromium', 'env_mobile', 'cap_user_stylesheet']),
  ios: new Set(['env_safari', 'env_mobile', 'cap_user_stylesheet']),
  desktop: new Set(['env_chromium', 'cap_user_stylesheet']),
};

const log = (...m) => console.log('[filters]', ...m);

async function fetchText(url) {
  const headers = { 'User-Agent': 'stillweb-filter-builder' };
  if (process.env.GITHUB_TOKEN && url.startsWith('https://api.github.com/')) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (attempt >= 3) throw new Error(`fetch ${url}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

// ---------------------------------------------------------------------------
// List preprocessing: adblock-rust treats `!#include` and `!#if` as comments, so
// resolve them here, once per platform.

/** Recursive-descent evaluator for `!#if` expressions: names, !, &&, ||, (). */
function evaluateCondition(expr, env) {
  const tokens = expr.match(/!|&&|\|\||\(|\)|[A-Za-z_][\w-]*/g) ?? [];
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const primary = () => {
    const t = next();
    if (t === '!') return !primary();
    if (t === '(') {
      const v = or();
      next(); // ')'
      return v;
    }
    if (t === 'true') return true;
    return env.has(t);
  };
  const and = () => {
    let v = primary();
    while (peek() === '&&') { next(); v = primary() && v; }
    return v;
  };
  const or = () => {
    let v = and();
    while (peek() === '||') { next(); v = and() || v; }
    return v;
  };
  return or();
}

async function loadListSource(url, depth = 0) {
  const text = (await fetchText(url)).toString('utf8');
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const include = line.match(/^!#include\s+(\S+)/);
    if (include && depth < 3) {
      const child = new URL(include[1], url);
      // Same-origin includes only, as in uBO.
      if (child.origin === new URL(url).origin) {
        out.push(`! >>> included ${child.pathname}`);
        out.push(...(await loadListSource(child.href, depth + 1)));
        out.push(`! <<< end ${child.pathname}`);
      }
      continue;
    }
    out.push(line);
  }
  return out;
}

/**
 * Rewrites filters that adblock-rust would otherwise drop. Returns the replacement lines
 * (usually just the input line).
 *
 * - `$popup` / `$popunder`: the app checks pop-up windows and script redirects as `document`
 *   requests and never checks pages the user opens, so blocking pop-up rules become
 *   `$document` rules. Pop-up exceptions are dropped: a `$document` exception would turn
 *   off blocking for a whole site.
 * - `denyallow=a|b`: "block, except requests to a or b". Expanded into the blocking rule
 *   plus one exception per allowed domain with the same options.
 */
function convertFilter(line) {
  if (!line || line.startsWith('!') || line.startsWith('[') || /#[@?$%]?#/.test(line)) return [line];
  const dollar = line.lastIndexOf('$');
  if (dollar <= 0) return [line];
  let pattern = line.slice(0, dollar);
  // Regex filters can contain `$`; leave them alone.
  if (pattern.startsWith('/') && !pattern.endsWith('/')) return [line];
  let options = line.slice(dollar + 1).split(',');
  const isException = line.startsWith('@@');

  const isPopup = (o) => o === 'popup' || o === 'popunder';
  if (options.some(isPopup)) {
    if (isException) {
      options = options.filter((o) => !isPopup(o));
      const hasType = options.some((o) => /^~?(document|subdocument|script|image|stylesheet|xmlhttprequest|xhr|media|font|object|other|ping|websocket|doc|frame|css|1p|3p|first-party|third-party|all)$/.test(o));
      if (!hasType) return [];
    } else {
      options = [...new Set(options.map((o) => (isPopup(o) ? 'document' : o)))];
    }
  }

  const deny = options.find((o) => o.startsWith('denyallow='));
  if (deny) {
    if (isException) return [];
    const rest = options.filter((o) => o !== deny);
    const allowed = deny.slice('denyallow='.length).split('|').filter((d) => d && !d.startsWith('~'));
    return [
      `${pattern}$${rest.join(',')}`,
      ...allowed.map((domain) => `@@||${domain}^$${rest.join(',')}`),
    ];
  }
  return [`${pattern}$${options.join(',')}`];
}

function preprocess(lines, env) {
  const out = [];
  const stack = []; // each entry: { active, parentActive }
  const active = () => (stack.length === 0 ? true : stack[stack.length - 1].active);
  for (const line of lines) {
    const ifMatch = line.match(/^!#if\s+(.*)$/);
    if (ifMatch) {
      const parent = active();
      stack.push({ active: parent && evaluateCondition(ifMatch[1], env), parentActive: parent });
      continue;
    }
    if (/^!#else\b/.test(line)) {
      const top = stack[stack.length - 1];
      if (top) top.active = top.parentActive && !top.active;
      continue;
    }
    if (/^!#endif\b/.test(line)) {
      stack.pop();
      continue;
    }
    if (!active()) continue;
    out.push(...convertFilter(line));
  }
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// uBlock Origin resources -> adblock-rust `Resource` JSON.

async function downloadGithubDir(repo, tag, dir, dest) {
  const listing = JSON.parse(
    (await fetchText(`https://api.github.com/repos/${repo}/contents/${dir}?ref=${tag}`)).toString('utf8'),
  );
  fs.mkdirSync(dest, { recursive: true });
  await Promise.all(
    listing
      .filter((entry) => entry.type === 'file')
      .map(async (entry) => {
        const data = await fetchText(`https://raw.githubusercontent.com/${repo}/${tag}/${entry.path}`);
        fs.writeFileSync(path.join(dest, entry.name), data);
      }),
  );
}

/** Downloads relative ES module imports of every .js file under `dir` that are missing locally. */
async function fetchMissingImports(repo, tag, base, dir) {
  const pending = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => path.join(dir, f));
  const seen = new Set(pending);
  while (pending.length) {
    const file = pending.pop();
    const source = fs.readFileSync(file, 'utf8');
    for (const [, spec] of source.matchAll(/(?:import|from)\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = path.resolve(path.dirname(file), spec);
      if (seen.has(target)) continue;
      seen.add(target);
      if (!fs.existsSync(target)) {
        const rel = path.relative(base, target).split(path.sep).join('/');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, await fetchText(`https://raw.githubusercontent.com/${repo}/${tag}/${rel}`));
      }
      pending.push(target);
    }
  }
}

async function buildResources() {
  const { repo, tag } = catalog.resources;
  const base = path.join(CACHE, `ubo-${tag}`);
  const resourcesDir = path.join(base, 'src/js/resources');
  const warDir = path.join(base, 'src/web_accessible_resources');
  const redirectMap = path.join(base, 'src/js/redirect-resources.js');

  if (!fs.existsSync(path.join(resourcesDir, 'scriptlets.js'))) {
    log(`downloading uBlock Origin ${tag} resources`);
    await downloadGithubDir(repo, tag, 'src/js/resources', resourcesDir);
    await downloadGithubDir(repo, tag, 'src/web_accessible_resources', warDir);
    fs.writeFileSync(
      redirectMap,
      await fetchText(`https://raw.githubusercontent.com/${repo}/${tag}/src/js/redirect-resources.js`),
    );
    // Node needs to know these are ES modules.
    fs.writeFileSync(path.join(base, 'src/js/package.json'), '{"type":"module"}');
  }
  await fetchMissingImports(repo, tag, base, resourcesDir);

  const resources = [];

  const { builtinScriptlets } = await import(pathToFileURL(path.join(resourcesDir, 'scriptlets.js')));
  for (const s of builtinScriptlets) {
    const isFn = s.name.endsWith('.fn');
    resources.push({
      name: s.name,
      aliases: s.aliases ?? [],
      kind: { mime: isFn ? 'fn/javascript' : 'application/javascript' },
      content: Buffer.from(s.fn.toString()).toString('base64'),
      dependencies: s.dependencies ?? [],
      ...(s.requiresTrust ? { permission: 1 } : {}),
    });
  }

  const mimeFor = (name) => {
    const ext = path.extname(name).slice(1);
    return (
      {
        css: 'text/css', gif: 'image/gif', html: 'text/html', js: 'application/javascript',
        json: 'application/json', mp3: 'audio/mp3', mp4: 'video/mp4', png: 'image/png',
        txt: 'text/plain', xml: 'text/xml',
      }[ext] ?? 'text/plain'
    );
  };
  const { default: redirects } = await import(pathToFileURL(redirectMap));
  const scriptletNames = new Set(resources.map((r) => r.name));
  for (const [name, props] of redirects) {
    if (scriptletNames.has(name)) continue;
    const file = path.join(warDir, name);
    if (!fs.existsSync(file)) continue;
    const alias = props.alias === undefined ? [] : [].concat(props.alias);
    resources.push({
      name,
      aliases: alias,
      kind: { mime: mimeFor(name) },
      content: fs.readFileSync(file).toString('base64'),
    });
  }

  log(`resources: ${builtinScriptlets.length} scriptlets, ${resources.length - builtinScriptlets.length} redirects`);
  return resources;
}

// ---------------------------------------------------------------------------

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function writeFile(rel, data) {
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return { file: rel, sha256: sha256(file), bytes: fs.statSync(file).size };
}

function compilerPath() {
  const crate = path.join(MODULE, 'rust');
  const bin = path.join(crate, 'target/release/filter-compiler');
  const cargo = path.join(os.homedir(), '.cargo/bin/cargo');
  log('building filter-compiler');
  execFileSync(fs.existsSync(cargo) ? cargo : 'cargo', ['build', '--release', '--features', 'compiler', '--bin', 'filter-compiler'], {
    cwd: crate,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return bin;
}

/**
 * Has WebKit itself compile the iOS rule lists (macOS only; skipped elsewhere and without the
 * Swift compiler). A list WebKit rejects gives the app no rules at all, so the build fails.
 */
function checkWithWebKit(files) {
  if (process.platform !== 'darwin') return log('WebKit check skipped (not macOS)');
  const tool = path.join(CACHE, 'webkit-check');
  const source = path.join(ROOT, 'scripts/filters/webkit-check.swift');
  try {
    if (!fs.existsSync(tool) || fs.statSync(tool).mtimeMs < fs.statSync(source).mtimeMs) {
      fs.mkdirSync(CACHE, { recursive: true });
      execFileSync('xcrun', ['swiftc', '-O', source, '-o', tool], { stdio: ['ignore', 'ignore', 'inherit'] });
    }
  } catch {
    return log('WebKit check skipped (no Swift compiler)');
  }
  log('checking the iOS rule lists with WebKit');
  try {
    execFileSync(tool, files, { stdio: ['ignore', 'inherit', 'inherit'] });
  } catch {
    throw new Error('WebKit rejected an iOS rule list (see above): the app would get no rules from it');
  }
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const raw = {};
  await Promise.all(
    catalog.lists.map(async (list) => {
      raw[list.id] = await loadListSource(list.url);
      log(`${list.id}: ${raw[list.id].length} lines`);
    }),
  );

  const manifest = {
    schema: 1,
    version: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    android: { lists: [], resources: null },
    ios: null,
    desktop: null,
  };

  const forPlatform = (platform) => catalog.lists.filter((l) => !l.platforms || l.platforms.includes(platform));

  // The desktop app reads the android lists; only the few lines inside `!#if env_mobile`
  // blocks differ, so it gets those as lines to drop and lines to add, per list.
  const delta = {};
  for (const list of forPlatform('android')) {
    const text = preprocess(raw[list.id], PLATFORM_ENV.android);
    const entry = writeFile(`android/${list.id}.txt`, text);
    // Optional groups (Calm Mode) are only used when the app turns them on.
    manifest.android.lists.push({ id: list.id, trusted: list.trusted, ...(list.group ? { group: list.group } : {}), ...entry });
    const mobile = new Set(text.split('\n'));
    const desktop = new Set(preprocess(raw[list.id], PLATFORM_ENV.desktop).split('\n'));
    const remove = [...mobile].filter((line) => line && !desktop.has(line));
    const add = [...desktop].filter((line) => line && !mobile.has(line));
    if (remove.length || add.length) delta[list.id] = { remove, add };
  }
  manifest.desktop = { delta: writeFile('desktop/delta.json', JSON.stringify(delta)) };
  log(`desktop: ${Object.entries(delta).map(([id, d]) => `${id} -${d.remove.length} +${d.add.length}`).join(', ') || 'no differences'}`);
  const resources = await buildResources();
  manifest.android.resources = writeFile('resources.json', JSON.stringify(resources));

  if (!flag('--skip-ios')) {
    const work = path.join(CACHE, 'ios-lists');
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    const coreArgs = [];
    const calmArgs = [];
    for (const list of forPlatform('ios')) {
      const file = path.join(work, `${list.id}.txt`);
      fs.writeFileSync(file, preprocess(raw[list.id], PLATFORM_ENV.ios));
      (list.group === 'calm' ? calmArgs : coreArgs).push('--list', `${file}${list.trusted ? ':trusted' : ''}`);
    }
    const iosOut = path.join(OUT, 'ios');
    const compiler = compilerPath();
    const compile = (args) =>
      JSON.parse(execFileSync(compiler, ['ios', ...args, '--out', iosOut], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
    const summary = compile([...coreArgs, '--resources', path.join(OUT, 'resources.json')]);
    // Calm Mode's lists: their own rule lists (attached only when it's on), honoring the core
    // lists' site exceptions. Their scriptlets aren't used on iOS.
    const contextArgs = coreArgs.map((a) => (a === '--list' ? '--context' : a));
    const calm = calmArgs.length ? compile([...calmArgs, ...contextArgs, '--no-scriptlets', '--prefix', 'calm']) : { ruleFiles: [] };
    manifest.ios = {
      rules: summary.ruleFiles.map((f) => ({ ...f, ...hashOf(`ios/${f.file}`) })),
      scriptlets: hashOf('ios/scriptlets.json'),
      calm: calm.ruleFiles.map((f) => ({ ...f, ...hashOf(`ios/${f.file}`) })),
    };
    log(`ios: ${[...summary.ruleFiles, ...calm.ruleFiles].map((f) => `${f.file}=${f.count}`).join(', ')}, ${summary.scriptletHosts} scriptlet hosts`);
    checkWithWebKit([...summary.ruleFiles, ...calm.ruleFiles].map((f) => path.join(iosOut, f.file)));
  }

  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  log(`wrote ${OUT}/manifest.json (version ${manifest.version})`);

  if (flag('--bundle')) bundleIntoApp(manifest);
  if (flag('--bundle') || flag('--bundle-desktop')) bundleIntoDesktop(manifest);
}

function hashOf(rel) {
  const file = path.join(OUT, rel);
  return { file: rel, sha256: sha256(file), bytes: fs.statSync(file).size };
}

/** Copies the build into the native module as the offline default bundle. */
function bundleIntoApp(manifest) {
  const copy = (rel, destRoot) => {
    const dest = path.join(destRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(OUT, rel), dest);
  };

  const androidAssets = path.join(MODULE, 'android/src/main/assets/shield');
  fs.rmSync(androidAssets, { recursive: true, force: true });
  for (const l of manifest.android.lists) copy(l.file, androidAssets);
  copy('resources.json', androidAssets);
  fs.writeFileSync(
    path.join(androidAssets, 'manifest.json'),
    JSON.stringify({ ...manifest, ios: null, desktop: null }, null, 2),
  );

  if (manifest.ios) {
    const iosAssets = path.join(MODULE, 'ios/Resources/shield');
    fs.rmSync(iosAssets, { recursive: true, force: true });
    for (const r of [...manifest.ios.rules, ...manifest.ios.calm]) copy(r.file, iosAssets);
    copy(manifest.ios.scriptlets.file, iosAssets);
    fs.writeFileSync(
      path.join(iosAssets, 'manifest.json'),
      JSON.stringify({ ...manifest, android: null, desktop: null }, null, 2),
    );
  }
  log('bundled default filters into native/shield-webview');
}

/**
 * The desktop app ships the android lists as they are bundled in the native module, plus
 * this file. A delta from a newer build than those lists is still correct: lines to drop
 * that are not there are skipped, and lines to add are ordinary filters.
 */
function bundleIntoDesktop(manifest) {
  const dest = path.join(ROOT, 'desktop/resources/shield-delta.json');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(OUT, manifest.desktop.delta.file), dest);
  log('bundled the desktop differences into desktop/resources');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
