/**
 * What the page on screen looks like at its edges, so the browser's bars can blend in with it:
 * whether it is dark (the status bar stays readable over it), and the colours painted at its
 * top and bottom edges (the bars take them, the way Safari's and Chrome's do). Resolves to
 * `{ dark, top, bottom }`: `dark` is null when the page has no background of its own (the canvas
 * then follows the app's theme), a colour is null when there is none to take (a photo or video
 * at that edge and no page background).
 */
export function pageLookScript(): string {
  return `(function () {
    try {
      var parse = function (value) {
        var m = /rgba?\\(([^)]+)\\)/.exec(value || '');
        if (!m) return null;
        var p = m[1].split(/[\\s,\\/]+/).filter(Boolean).map(parseFloat);
        if ((p.length > 3 ? p[3] : 1) < 0.9) return null;
        return [Math.round(p[0]), Math.round(p[1]), Math.round(p[2])];
      };
      var page = null, els = [document.body, document.documentElement];
      for (var i = 0; i < els.length && !page; i++) {
        if (els[i]) page = parse(getComputedStyle(els[i]).backgroundColor);
      }
      // The site's own choice for browser bars, where it names one.
      var named = null, metas = document.querySelectorAll('meta[name="theme-color"]');
      for (var j = 0; j < metas.length && !named; j++) {
        var media = metas[j].getAttribute('media');
        if (media && !matchMedia(media).matches) continue;
        var probe = document.createElement('span');
        probe.style.color = metas[j].getAttribute('content') || '';
        if (!probe.style.color) continue;
        probe.style.display = 'none';
        document.documentElement.appendChild(probe);
        named = parse(getComputedStyle(probe).color);
        probe.remove();
      }
      // The colour painted in the middle of a row of the page: the nearest solid background
      // behind that point (null for pictures, videos and gradients).
      var at = function (y) {
        var el = document.elementFromPoint(Math.floor(innerWidth / 2), y);
        for (var n = el, k = 0; n && n.nodeType === 1 && k < 60; n = n.parentElement, k++) {
          if (n === document.body || n === document.documentElement) return page;
          if (/^(IMG|VIDEO|CANVAS|PICTURE|SVG|IFRAME|EMBED|OBJECT)$/i.test(n.tagName)) return null;
          var style = getComputedStyle(n);
          var colour = parse(style.backgroundColor);
          if (colour) return colour;
          if (style.backgroundImage && style.backgroundImage !== 'none') return null;
        }
        return page;
      };
      var hex = function (c) {
        return c ? '#' + c.map(function (v) { return (v < 16 ? '0' : '') + v.toString(16); }).join('') : null;
      };
      var lum = function (c) {
        var ch = function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]);
      };
      return {
        dark: page ? lum(page) < 0.2 : null,
        top: hex(at(1) || named || page),
        bottom: hex(at(innerHeight - 2) || page)
      };
    } catch (e) {}
    return null;
  })()`;
}

export type PageLook = { pageDark?: boolean; pageTop?: string; pageBottom?: string };

/** The evaluateJavaScript result of pageLookScript as tab fields (undefined: unknown). */
export function parsePageLook(raw: string | null | undefined): PageLook {
  let value: unknown = null;
  try {
    value = raw ? JSON.parse(raw) : null;
  } catch {}
  const look = (value ?? {}) as { dark?: unknown; top?: unknown; bottom?: unknown };
  const colour = (c: unknown) => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : undefined);
  return {
    pageDark: typeof look.dark === 'boolean' ? look.dark : undefined,
    pageTop: colour(look.top),
    pageBottom: colour(look.bottom),
  };
}

/** Whether a `#rrggbb` colour is dark (light text and icons go on it). */
export function isDarkColour(hex: string): boolean {
  const channel = (i: number) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5) < 0.3;
}
