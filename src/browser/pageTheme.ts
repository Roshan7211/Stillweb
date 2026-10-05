/**
 * Whether the page on screen is dark, from its background colour: Stillweb keeps the status
 * bar readable over it (edge-to-edge layout). Resolves (as JSON) to true, false, or null when
 * the page has no background of its own (the canvas then follows the app's theme).
 */
export function pageDarkScript(): string {
  return `(function () {
    try {
      var els = [document.body, document.documentElement];
      for (var i = 0; i < els.length; i++) {
        if (!els[i]) continue;
        var m = /rgba?\\(([^)]+)\\)/.exec(getComputedStyle(els[i]).backgroundColor || '');
        if (!m) continue;
        var p = m[1].split(/[\\s,\\/]+/).filter(Boolean).map(parseFloat);
        if ((p.length > 3 ? p[3] : 1) <= 0.5) continue;
        var ch = function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * ch(p[0]) + 0.7152 * ch(p[1]) + 0.0722 * ch(p[2]) < 0.2;
      }
    } catch (e) {}
    return null;
  })()`;
}

/** The evaluateJavaScript result of pageDarkScript as a value (undefined: unknown). */
export function parsePageDark(raw: string | null | undefined): boolean | undefined {
  return raw === 'true' ? true : raw === 'false' ? false : undefined;
}
