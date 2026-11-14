// Turns the published privacy policy (site/privacy/index.html) into data the app shows on its
// own page (src/ui/privacy.generated.json), so the app never opens the policy's web address.
// Run after editing the policy: npm run build:privacy
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'site/privacy/index.html'), 'utf8');
const main = html.match(/<main>([\s\S]*?)<\/main>/)?.[1];
if (!main) throw new Error('gen-privacy: no <main> in site/privacy/index.html');

const decode = (s) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

/** Inline text: runs of plain, bold, italic and linked text. */
function inline(fragment) {
  const parts = [];
  const style = { bold: false, italic: false, href: null };
  const text = fragment.replace(/\s+/g, ' ');
  const tag = /<(\/?)(strong|b|em|i|a)\b([^>]*)>/g;
  let last = 0;
  const push = (t) => {
    if (!t) return;
    const part = { text: decode(t) };
    if (style.bold) part.bold = true;
    if (style.italic) part.italic = true;
    if (style.href) part.href = style.href;
    parts.push(part);
  };
  for (const m of text.matchAll(tag)) {
    push(text.slice(last, m.index));
    last = m.index + m[0].length;
    const closing = m[1] === '/';
    const name = m[2];
    if (name === 'strong' || name === 'b') style.bold = !closing;
    else if (name === 'em' || name === 'i') style.italic = !closing;
    else style.href = closing ? null : (m[3].match(/href="([^"]+)"/)?.[1] ?? null);
  }
  push(text.slice(last));
  if (/<[a-z]/i.test(parts.map((p) => p.text).join(''))) throw new Error(`gen-privacy: unexpected markup in: ${fragment}`);
  // Trim the outer spaces of the whole run.
  if (parts.length) {
    parts[0].text = parts[0].text.replace(/^ /, '');
    parts[parts.length - 1].text = parts[parts.length - 1].text.replace(/ $/, '');
  }
  return parts;
}

const blocks = [];
const block = /<h1>([\s\S]*?)<\/h1>|<p class="meta">([\s\S]*?)<\/p>|<div class="summary">([\s\S]*?)<\/div>|<h2>([\s\S]*?)<\/h2>|<p>([\s\S]*?)<\/p>|<li>([\s\S]*?)<\/li>/g;
for (const m of main.matchAll(block)) {
  if (m[1] !== undefined) blocks.push({ type: 'title', parts: inline(m[1]) });
  else if (m[2] !== undefined) blocks.push({ type: 'meta', parts: inline(m[2]) });
  else if (m[3] !== undefined) blocks.push({ type: 'summary', parts: inline(m[3]) });
  else if (m[4] !== undefined) blocks.push({ type: 'heading', parts: inline(m[4]) });
  else if (m[5] !== undefined) blocks.push({ type: 'paragraph', parts: inline(m[5]) });
  else if (m[6] !== undefined) blocks.push({ type: 'item', parts: inline(m[6]) });
}
if (blocks.length < 10) throw new Error(`gen-privacy: only ${blocks.length} blocks found`);

const out = join(root, 'src/ui/privacy.generated.json');
writeFileSync(out, JSON.stringify(blocks, null, 1) + '\n');
console.log(`gen-privacy: ${blocks.length} blocks -> src/ui/privacy.generated.json`);
