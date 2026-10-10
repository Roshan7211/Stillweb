// `npm test` (electron . --self-test): runs the real app against a local web server and
// checks blocking, the browser's own behavior and the interface. Every host name resolves
// to this computer (see main.ts), so rules written for real sites can be exercised safely.
import { BrowserWindow, app, nativeTheme, type WebContents } from 'electron';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { BrowserWin } from './browserWindow';
import { getBookmarks, localSuggestions, queryHistory } from './data';
import { getDownloads } from './downloads';
import { shieldEngine } from './engine/shieldEngine';
import { rememberMediaSite } from './mediaSites';
import { newWindow } from './menus';
import { getSettings, updateSettings } from './settings';
import { pageInfo } from './shields';

type Hit = { host: string; url: string; cookie: string };

const results: { name: string; ok: boolean; detail: string }[] = [];
const hits: Hit[] = [];
/** Every host name is mapped to this port on this computer (see main.ts). */
export const SELF_TEST_PORT = 47831;
const port = SELF_TEST_PORT;
let outDir = '';

function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 6000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await condition()) return true;
    await sleep(50);
  }
  return false;
}

const seen = (pathPrefix: string, host?: string) => hits.filter((hit) => hit.url.startsWith(pathPrefix) && (!host || hit.host.startsWith(host)));

/** The first rules in a bundled list that match, skipping sites that are not fit for a test log. */
function findRules(list: string, pattern: RegExp, limit = 1): RegExpMatchArray[] {
  const text = fs.readFileSync(path.join(shieldEngine.bundledDir(), 'android', list), 'utf8');
  const found: RegExpMatchArray[] = [];
  for (const match of text.matchAll(pattern)) {
    if (!/porn|sex|xxx|adult|hentai/i.test(match[0])) found.push(match);
    if (found.length >= limit) break;
  }
  return found;
}

function fixturePage(query: URLSearchParams): string {
  const prop = JSON.stringify(query.get('prop') ?? '');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Fixture page</title>
<script>window.__early = window[${prop}];</script>
<script src="/app.js"></script>
<script src="http://securepubads.g.doubleclick.net/tag/js/gpt.js"></script>
</head><body style="font-family:sans-serif">
<h1>Fixture page</h1><p>Text to look for: stillwebneedle and again stillwebneedle.</p>
<div id="specific" class="${query.get('specific') ?? ''}">specific ad</div>
<div id="generic" class="${query.get('generic') ?? ''}">generic ad</div>
<button id="fullscreen" onclick="document.documentElement.requestFullscreen()" style="display:block;width:200px;height:40px">full screen</button>
<iframe id="adframe" src="http://googleads.g.doubleclick.net/pagead/ads?client=x" width="300" height="60"></iframe>
<a id="poplink" href="#" onclick="window.open('http://popup.example.org/popup');return false" style="display:block;width:200px;height:40px;background:#ddd">open a window</a>
<img src="http://127.0.0.1:${port}/photo.png?n=1" onload="var i=new Image();i.src='http://127.0.0.1:${port}/photo.png?n=2'">
<script>fetch('/fp?n=1').then(function(){return fetch('/fp?n=2')});</script>
</body></html>`;
}

/** A quiet tone as a WAV file (8-bit mono), `seconds` long. */
function wav(seconds: number): Buffer {
  const rate = 8000;
  const samples = rate * seconds;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + samples, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write('data', 36);
  header.writeUInt32LE(samples, 40);
  const data = Buffer.alloc(samples);
  for (let i = 0; i < samples; i++) data[i] = 128 + Math.round(20 * Math.sin((i * 2 * Math.PI * 440) / rate));
  return Buffer.concat([header, data]);
}

function startServer(): Promise<void> {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://x');
    hits.push({ host: request.headers.host ?? '', url: request.url ?? '', cookie: request.headers.cookie ?? '' });
    if (url.pathname === '/app.js') {
      response.setHeader('Content-Type', 'application/javascript');
      return response.end('window.__app = true;');
    }
    if (url.pathname.endsWith('.js')) {
      response.setHeader('Content-Type', 'application/javascript');
      return response.end('window.__adScriptRan = true;');
    }
    if (url.pathname === '/photo.png') {
      response.setHeader('Content-Type', 'image/gif');
      // Browsers accept Secure cookies from http://127.0.0.1, which makes a cross-site cookie testable.
      response.setHeader('Set-Cookie', 'tp=1; SameSite=None; Secure; Path=/');
      return response.end(Buffer.from('R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', 'base64'));
    }
    if (url.pathname === '/sound.wav') {
      response.setHeader('Content-Type', 'audio/wav');
      return response.end(wav(3));
    }
    if (url.pathname === '/player') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      // A page that starts sound by itself, as a video page does.
      return response.end(`<title>Player</title><audio id="a" src="/sound.wav" loop></audio><script>
window.__play = 'pending';
document.getElementById('a').play().then(function () { window.__play = 'playing'; }, function (e) { window.__play = e.name; });</script>`);
    }
    if (url.pathname === '/fp') {
      response.setHeader('Set-Cookie', 'fp=1; Path=/');
      return response.end('ok');
    }
    if (url.pathname === '/file.bin') {
      response.setHeader('Content-Type', 'application/octet-stream');
      response.setHeader('Content-Disposition', 'attachment; filename="stillweb-test.bin"');
      return response.end(Buffer.alloc(2048, 7));
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (url.pathname === '/popup') return response.end('<title>Popup</title><script>document.title = "Popup opener:" + (window.opener ? "yes" : "no")</script>');
    response.end(fixturePage(url.searchParams));
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve());
  });
}

/** Opens an address in the window's active tab and waits until it has finished loading. */
async function open(win: BrowserWin, url: string): Promise<WebContents> {
  win.navigate(url);
  const tab = win.activeTab!;
  await sleep(150);
  await waitFor(() => !tab.loading && !tab.contents.isLoading(), 10000);
  await sleep(250);
  return tab.contents;
}

const inPage = <T,>(contents: WebContents, code: string) => contents.executeJavaScript(code) as Promise<T>;
const inChrome = <T,>(win: BrowserWin, code: string) => win.chrome.webContents.executeJavaScript(code) as Promise<T>;

/** Pictures are for a person to look at; a capture that fails (a locked screen) fails no check. */
async function screenshot(win: BrowserWin, name: string): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await capture(win, name);
    } catch (error) {
      if (attempt === 3) console.log(`  (no screenshot ${name}: ${error instanceof Error ? error.message : error})`);
      else await sleep(400);
    }
  }
}

/** One picture of the window: the page with the interface drawn over it, as on screen. */
async function capture(win: BrowserWin, name: string): Promise<void> {
  const [width, height] = win.window.getContentSize();
  const tab = win.activeTab;
  const layers: string[] = [];
  if (tab && tab.url && !tab.error) {
    const bounds = tab.view.getBounds();
    const image = await tab.contents.capturePage();
    layers.push(`<img src="${image.toDataURL()}" style="position:absolute;left:${bounds.x}px;top:${bounds.y}px;width:${bounds.width}px;height:${bounds.height}px">`);
  }
  const chromeBounds = win.chrome.getBounds();
  const chrome = await win.chrome.webContents.capturePage();
  layers.push(`<img src="${chrome.toDataURL()}" style="position:absolute;left:0;top:0;width:${chromeBounds.width}px;height:${chromeBounds.height}px">`);
  const file = path.join(outDir, `${name}.html`);
  fs.writeFileSync(file, `<body style="margin:0;background:#fff;overflow:hidden">${layers.join('')}</body>`);
  const stage = new BrowserWindow({ show: false, width, height, useContentSize: true, webPreferences: { offscreen: true } });
  await stage.loadFile(file);
  await sleep(200);
  fs.writeFileSync(path.join(outDir, `${name}.png`), (await stage.webContents.capturePage()).toPNG());
  stage.destroy();
  fs.rmSync(file);
}

export async function runSelfTest(win: BrowserWin): Promise<void> {
  const timeout = setTimeout(() => {
    console.log('FAIL the self-test did not finish in time');
    app.exit(1);
  }, 120_000);
  try {
    outDir = process.env.STILLWEB_TEST_OUT || path.join(app.getPath('temp'), 'stillweb-self-test-out');
    fs.mkdirSync(outDir, { recursive: true });
    const downloads = path.join(app.getPath('userData'), 'downloads');
    fs.mkdirSync(downloads, { recursive: true });
    app.setPath('downloads', downloads);
    await startServer();
    win.window.setContentSize(1200, 800);
    const shields = getSettings().shields;
    // Local test hosts have no https; the upgrade is tested on its own below.
    updateSettings({ shields: { ...shields, httpsUpgrade: false } });

    await waitFor(() => shieldEngine.isReady || !!shieldEngine.lastError, 30000);
    check('filters load', shieldEngine.isReady, shieldEngine.lastError ?? `version ${shieldEngine.version}, ${shieldEngine.buildMillis} ms`);

    await waitFor(() => inChrome<boolean>(win, '!!document.querySelector(".tabstrip")'), 8000);
    check('new tab page shows in a new window', await inChrome<boolean>(win, '!!document.querySelector(".newtab")'));
    check('address bar has the cursor in a new tab', await inChrome<boolean>(win, 'document.activeElement === document.querySelector(".address-input")'));
    await screenshot(win, '01-new-tab');

    // ---- Blocking ----
    const [scriptlet] = findRules('ubo-filters.txt', /^([a-z0-9-]+(?:\.[a-z0-9-]+)+)##\+js\((?:set|set-constant), ([A-Za-z_$][\w$]*), (true|false)\)$/gm);
    const specifics = findRules('easylist.txt', /^([a-z0-9-]+(?:\.[a-z0-9-]+)+)##\.([A-Za-z][\w-]*)$/gm, 8);
    const [generic] = findRules('easylist.txt', /^##\.([A-Za-z][\w-]*)$/gm);
    check('test rules found in the bundled lists', !!scriptlet && specifics.length > 0 && !!generic);
    if (!scriptlet || !specifics.length || !generic) throw new Error('no rules to test with');

    const site = `http://${scriptlet[1]}`;
    const pageUrl = `${site}/?prop=${scriptlet[2]}&generic=${generic[1]}`;
    let page = await open(win, pageUrl);
    check('first-party script loads', await inPage<boolean>(page, 'window.__app === true'));
    check('ad script request never reaches the server', seen('/tag/js/gpt.js').length === 0, `${seen('/tag/js/gpt.js').length} requests`);
    check('blocked ad script is replaced by a harmless stand-in', await inPage<boolean>(page, 'typeof window.googletag === "object" && window.__adScriptRan !== true'));
    check('scriptlet runs before the page’s first script', (await inPage<unknown>(page, 'window.__early')) === (scriptlet[3] === 'true'), `${scriptlet[0]}`);
    check('generic cosmetic rule hides the element', await waitFor(() => inPage<boolean>(page, 'getComputedStyle(document.getElementById("generic")).display === "none"'), 4000), generic[0]);
    check('page counter shows blocked requests', pageInfo(page).blocked > 0, `${pageInfo(page).blocked} blocked`);
    const firstCount = pageInfo(page).blocked;
    page.reload();
    await sleep(300);
    await waitFor(() => !page.isLoading(), 8000);
    await sleep(400);
    check('the counter starts again when the page is reloaded', pageInfo(page).blocked === firstCount, `${firstCount} before, ${pageInfo(page).blocked} after`);
    const adFrame = page.mainFrame.frames[0];
    const adText = adFrame ? await adFrame.executeJavaScript('document.body ? document.body.innerText : ""').catch((e: Error) => `error: ${e.message}`) : 'no frame';
    check('a blocked ad frame is never requested and stays empty', seen('/pagead/ads').length === 0 && adText === '', `text "${adText}"`);
    await waitFor(() => inChrome<boolean>(win, '!!document.querySelector(".shield .badge")'), 2000);
    check('toolbar badge shows the count', await inChrome<boolean>(win, '!!document.querySelector(".shield .badge")'));
    check('address bar shows the page', (await inChrome<string>(win, 'document.querySelector(".address-input").value')).startsWith(scriptlet[1]));
    await screenshot(win, '02-page');

    // Chromium only opens some well-known sites over https, which the test server does not
    // speak: take the first rule whose site loads.
    let specific = specifics[0];
    for (specific of specifics) {
      page = await open(win, `http://${specific[1]}/?specific=${specific[2]}`);
      if (page.getTitle() === 'Fixture page') break;
    }
    check('site-specific cosmetic rule hides the element', await waitFor(() => inPage<boolean>(page, 'getComputedStyle(document.getElementById("specific")).display === "none"'), 4000), specific[0]);

    // ---- Cookies ----
    await waitFor(() => seen('/photo.png?n=2').length > 0 && seen('/fp?n=2').length > 0, 4000);
    const lastPixel = seen('/photo.png?n=2').at(-1);
    const lastFirstParty = seen('/fp?n=2').at(-1);
    check('third-party cookie is not sent', !!lastPixel && !lastPixel.cookie.includes('tp=1'), `Cookie: "${lastPixel?.cookie ?? 'no request'}"`);
    check('first-party cookie is sent', !!lastFirstParty && lastFirstParty.cookie.includes('fp=1'), `Cookie: "${lastFirstParty?.cookie ?? 'no request'}"`);
    updateSettings({ shields: { ...getSettings().shields, blockThirdPartyCookies: false } });
    hits.length = 0;
    page = await open(win, `${site}/?allow-cookies`);
    await waitFor(() => seen('/photo.png?n=2').length > 0, 4000);
    check('third-party cookie is sent when the setting is off', !!seen('/photo.png?n=2').at(-1)?.cookie.includes('tp=1'), `Cookie: "${seen('/photo.png?n=2').at(-1)?.cookie ?? 'no request'}"`);
    updateSettings({ shields: { ...getSettings().shields, blockThirdPartyCookies: true } });

    // ---- Pop-ups ----
    let tabsBefore = win.tabs.length;
    await inPage(page, `window.open("http://popup.example.org/popup"); 0`);
    await sleep(500);
    check('pop-up without a click is blocked', win.tabs.length === tabsBefore, `${win.tabs.length - tabsBefore} tabs opened`);
    const box = await inPage<{ x: number; y: number }>(page, '(function(){var r=document.getElementById("poplink").getBoundingClientRect();return {x:Math.round(r.left+20),y:Math.round(r.top+10)}})()');
    page.sendInputEvent({ type: 'mouseDown', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    page.sendInputEvent({ type: 'mouseUp', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    const opened = await waitFor(() => win.tabs.length === tabsBefore + 1, 4000);
    check('a window the user asked for opens as a new tab', opened);
    if (opened) {
      const popup = win.activeTab!;
      await waitFor(() => popup.title.startsWith('Popup opener:'), 4000);
      check('new tab is in front and keeps its link to the page that opened it', popup.title === 'Popup opener:yes', popup.title);
      win.closeTab(popup.id);
      await waitFor(() => win.tabs.length === tabsBefore, 3000);
      check('closing a tab returns to the previous one', win.tabs.length === tabsBefore && win.activeTab?.contents === page);
    }

    // ---- Shields off for one site ----
    hits.length = 0;
    const host = scriptlet[1].replace(/^www\./, '');
    updateSettings({ disabledSites: [host] });
    page = await open(win, `${pageUrl}&off`);
    check('with Shields off for the site, the ad script loads', seen('/tag/js/gpt.js').length > 0 && (await inPage<boolean>(page, 'window.__adScriptRan === true')));
    check('with Shields off for the site, nothing is hidden', await inPage<boolean>(page, 'getComputedStyle(document.getElementById("generic")).display !== "none"'));
    check('with Shields off for the site, scriptlets do not run', (await inPage<unknown>(page, 'window.__early')) === undefined);
    check('toolbar shows Shields off', await waitFor(() => inChrome<boolean>(win, '!!document.querySelector(".shield.off")'), 2000));
    updateSettings({ disabledSites: [] });

    // ---- HTTPS upgrade with fallback ----
    updateSettings({ shields: { ...getSettings().shields, httpsUpgrade: true } });
    hits.length = 0;
    page = await open(win, `http://plain.example.net/?upgrade`);
    await waitFor(() => /^http:\/\/plain\.example\.net/.test(page.getURL()), 8000);
    check('a site without https still opens after the upgrade fails', page.getURL().startsWith('http://plain.example.net') && (await inPage<boolean>(page, 'window.__app === true')), page.getURL());
    updateSettings({ shields: { ...getSettings().shields, httpsUpgrade: false } });

    // ---- Full screen from a page ----
    const size = win.window.getContentSize();
    const button = await inPage<{ x: number; y: number }>(page, '(function(){var r=document.getElementById("fullscreen").getBoundingClientRect();return {x:Math.round(r.left+20),y:Math.round(r.top+10)}})()');
    page.sendInputEvent({ type: 'mouseDown', x: button.x, y: button.y, button: 'left', clickCount: 1 });
    page.sendInputEvent({ type: 'mouseUp', x: button.x, y: button.y, button: 'left', clickCount: 1 });
    const entered = await waitFor(() => inPage<boolean>(page, '!!document.fullscreenElement'), 5000);
    await sleep(1500);
    const full = win.window.getContentSize();
    const pageBounds = win.activeTab!.view.getBounds();
    check('a page can go full screen, covering the bars', entered && win.window.isFullScreen() && pageBounds.y === 0 && pageBounds.height === full[1], `page ${JSON.stringify(pageBounds)} in window ${full.join('x')}`);
    page.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    page.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    const left = await waitFor(() => inPage<boolean>(page, '!document.fullscreenElement'), 5000);
    await waitFor(() => !win.window.isFullScreen(), 5000);
    await sleep(1200);
    const after = win.activeTab!.view.getBounds();
    check('Escape leaves full screen and the bars come back', left && !win.window.isFullScreen() && after.y > 0 && win.window.getContentSize()[1] === size[1], `page ${JSON.stringify(after)}, window ${win.window.getContentSize().join('x')}`);

    // ---- Sound that starts by itself ----
    page = await open(win, 'http://quiet.example.net/player');
    await waitFor(async () => (await inPage<string>(page, 'window.__play')) !== 'pending', 4000);
    check('a page cannot start sound by itself', (await inPage<string>(page, 'window.__play')) === 'NotAllowedError', await inPage<string>(page, 'window.__play'));
    rememberMediaSite('http://music.example.net/');
    page = await open(win, 'http://music.example.net/player');
    await waitFor(async () => (await inPage<string>(page, 'window.__play')) !== 'pending', 4000);
    check('a site the user has played media on can', (await inPage<string>(page, 'window.__play')) === 'playing', await inPage<string>(page, 'window.__play'));
    check('the tab shows that it is playing sound', await waitFor(() => win.activeTab!.audible, 4000));
    const background = win.createTab({ url: 'http://music.example.net/player?background', activate: false });
    await waitFor(() => !background.loading && background.committed, 6000);
    await sleep(500);
    check('but not in a tab that is not in front', (await inPage<string>(background.contents, 'window.__play')) === 'NotAllowedError', await inPage<string>(background.contents, 'window.__play'));
    win.closeTab(background.id);

    // ---- Tabs from last time load when first shown ----
    const asleep = win.createTab({ url: `${site}/?asleep`, activate: false, asleep: true });
    await sleep(600);
    check('a restored tab waits', asleep.contents.getURL() === '' && asleep.state().url.endsWith('?asleep'), `loaded "${asleep.contents.getURL()}"`);
    win.activate(asleep.id);
    check('and loads when it is shown', await waitFor(() => asleep.contents.getURL().endsWith('?asleep') && !asleep.loading, 6000));
    win.closeTab(asleep.id);
    await waitFor(() => win.activeTab?.contents === page, 3000);

    // ---- The address bar ----
    win.navigate('javascript:document.title="ran"');
    await sleep(1200);
    check('script typed into the address bar is searched for, not run', page.getTitle() !== 'ran' && /search\?q=javascript/.test(win.activeTab!.url), win.activeTab!.url.slice(0, 60));
    page = await open(win, `${site}/?after-search`);

    // ---- Find in page ----
    let found = { active: 0, count: 0 };
    page.once('found-in-page', (_event, result) => {
      found = { active: result.activeMatchOrdinal, count: result.matches };
    });
    page.findInPage('stillwebneedle');
    await waitFor(() => found.count > 0, 3000);
    check('find in page counts the matches', found.count === 2, `${found.count} matches`);
    page.stopFindInPage('clearSelection');
    check('pages cannot see the interface’s commands', (await inPage<string>(page, 'typeof window.stillweb')) === 'undefined');

    // ---- History, suggestions, bookmarks ----
    check('visited pages are in history', queryHistory('plain.example.net').length > 0);
    check('history is suggested in the address bar', localSuggestions('plain.example').some((s) => s.url.includes('plain.example.net')));
    await inChrome(win, `window.stillweb.setBookmarked(${JSON.stringify(page.getURL())}, "Fixture", true)`);
    check('bookmark is saved', getBookmarks().some((b) => b.url === page.getURL()));
    check('bookmark star is filled', await waitFor(() => inChrome<boolean>(win, '!!document.querySelector(".address .icon-button.on")'), 2000));

    // ---- Interface: panels and lists over the page ----
    win.send('open-panel', 'settings');
    await waitFor(() => inChrome<boolean>(win, '!!document.querySelector(".sheet")'), 3000);
    await sleep(300);
    check('settings panel opens over the page', win.chrome.getBounds().height === win.window.getContentSize()[1]);
    await screenshot(win, '03-settings');
    win.send('open-panel', 'privacy');
    await sleep(400);
    await screenshot(win, '04-privacy-report');
    win.send('open-panel', 'about');
    await sleep(400);
    await screenshot(win, '05-about');
    await inChrome(win, 'document.querySelector(".sheet-header .icon-button").click()');
    await waitFor(() => win.chrome.getBounds().height < 200, 3000);
    check('closing the panel gives the page back its space', win.chrome.getBounds().height < 200, `bars are ${win.chrome.getBounds().height}px`);
    await inChrome(win, 'document.querySelector(".shield").click()');
    await waitFor(() => inChrome<boolean>(win, '!!document.querySelector(".shield-popover")'), 3000);
    await sleep(300);
    await screenshot(win, '06-shield-popover');
    await inChrome(win, 'document.querySelector(".shield").click()');

    // ---- A page that fails to load ----
    page = await open(win, 'http://closed.invalid/');
    await waitFor(() => !!win.activeTab?.error, 6000);
    check('a failed page shows the error screen', !!win.activeTab?.error && (await waitFor(() => inChrome<boolean>(win, '!!document.querySelector(".errorpage")'), 3000)), win.activeTab?.error?.description ?? '');
    await sleep(200);
    await screenshot(win, '07-error');

    // ---- Downloads ----
    win.createTab({ url: `${site}/file.bin` });
    const downloaded = await waitFor(() => getDownloads().some((d) => d.state === 'completed'), 8000);
    const file = getDownloads()[0];
    check('a download is saved to the Downloads folder', downloaded && !!file && fs.existsSync(file.path) && fs.statSync(file.path).size === 2048, file?.path ?? 'no download');
    await sleep(500);
    await screenshot(win, '08-downloads');

    // ---- Private window ----
    const privateWin = newWindow(true);
    privateWin.window.setContentSize(1200, 800);
    await waitFor(() => inChrome<boolean>(privateWin, '!!document.querySelector(".newtab")'), 8000);
    await sleep(300);
    await screenshot(privateWin, '09-private-new-tab');
    hits.length = 0;
    await open(privateWin, `${site}/?private`);
    await waitFor(() => seen('/fp?n=1').length > 0, 4000);
    check('a private window does not share cookies with normal windows', seen('/fp?n=1').at(-1)?.cookie === '', `Cookie: "${seen('/fp?n=1').at(-1)?.cookie}"`);
    check('private pages are not added to history', queryHistory('?private').length === 0);
    await screenshot(privateWin, '10-private-page');
    privateWin.window.close();

    // ---- The other theme (the test started in the system's) ----
    const other = nativeTheme.shouldUseDarkColors ? 'light' : 'dark';
    updateSettings({ theme: other });
    await open(win, `${site}/?theme`);
    await sleep(400);
    check(`${other} theme applies to the interface`, (await inChrome<string>(win, 'document.documentElement.style.colorScheme')) === other);
    await screenshot(win, `11-${other}-page`);
    win.send('open-panel', 'settings');
    await sleep(500);
    await screenshot(win, `12-${other}-settings`);
    win.send('open-panel', 'history');
    await sleep(500);
    await screenshot(win, `13-${other}-history`);
    await inChrome(win, 'document.querySelector(".sheet-header .icon-button").click()');
    win.createTab();
    await sleep(600);
    check('shield counter adds up across pages', win.state().totalBlocked >= 5, `${win.state().totalBlocked} in total`);
    await screenshot(win, `14-${other}-new-tab`);
  } catch (error) {
    check('self-test ran to the end', false, error instanceof Error ? (error.stack ?? error.message) : String(error));
  }
  clearTimeout(timeout);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed. Screenshots: ${outDir}`);
  app.exit(failed.length ? 1 : 0);
}

/**
 * `electron . --live-check=<address>,<address>`: opens real pages with a fresh profile and
 * reports, for each, where it ended up, how many requests were blocked and a screenshot.
 */
export async function runLiveCheck(win: BrowserWin, urls: string[]): Promise<void> {
  outDir = process.env.STILLWEB_TEST_OUT || path.join(app.getPath('temp'), 'stillweb-live-check-out');
  fs.mkdirSync(outDir, { recursive: true });
  win.window.setContentSize(1280, 860);
  await waitFor(() => shieldEngine.isReady || !!shieldEngine.lastError, 30000);
  console.log(shieldEngine.isReady ? `filters ${shieldEngine.version}` : `filters failed: ${shieldEngine.lastError}`);
  let index = 0;
  for (const url of urls) {
    const started = Date.now();
    const page = await open(win, url);
    // Ads and trackers keep arriving after the page itself has loaded.
    await sleep(4000);
    const tab = win.activeTab!;
    const name = `live-${String(++index).padStart(2, '0')}`;
    console.log(
      `${name} ${url}\n  -> ${tab.url}\n  title: ${tab.title}\n  blocked: ${pageInfo(page).blocked}, ${Date.now() - started - 4000} ms to load` +
        (tab.error ? `\n  ERROR: ${tab.error.description}` : ''),
    );
    await screenshot(win, name);
  }
  console.log(`Screenshots: ${outDir}`);
  app.exit(0);
}
