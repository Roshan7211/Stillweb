import type { Theme } from '../ui/theme';
import { READABILITY_SOURCE } from './readability.generated';

/**
 * Script that runs Readability on the current page and, if an article is found, replaces
 * the page with a clean reading view. Evaluates to true on success. Leaving reader mode
 * is a reload. Styles go through a constructable sheet so page CSP can't block them.
 */
/** Reader view's look, in the app's theme. */
function readerCss(theme: Theme): string {
  return `
    html { background: ${theme.background}; }
    body { margin: 0 auto; max-width: 42rem; padding: 24px 20px 64px; background: ${theme.background};
      color: ${theme.text}; font: 19px/1.6 Georgia, 'Times New Roman', serif; -webkit-text-size-adjust: 100%; }
    h1.reader-title { font: 700 1.6em/1.25 system-ui, sans-serif; margin: 0 0 8px; }
    .reader-meta { color: ${theme.muted}; font: 0.8em system-ui, sans-serif; margin-bottom: 24px; }
    img, video, figure, iframe { max-width: 100%; height: auto; }
    a { color: ${theme.accent}; }
    pre, code { white-space: pre-wrap; font-size: 0.85em; }
    blockquote { border-left: 3px solid ${theme.border}; margin-left: 0; padding-left: 16px; color: ${theme.muted}; }
    table { display: block; overflow-x: auto; }
  `;
}

export function readerScript(theme: Theme): string {
  const css = readerCss(theme);
  return `(function () {
    try {
      ${READABILITY_SOURCE}
      var article = new Readability(document.cloneNode(true)).parse();
      if (!article || !article.content || article.length < 200) return false;
      var esc = function (s) { var d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; };
      var meta = [article.siteName, article.byline].filter(Boolean).map(esc).join(' · ');
      document.documentElement.innerHTML = '<head><meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
        esc(article.title) + '</title></head><body><h1 class="reader-title">' + esc(article.title) + '</h1>' +
        (meta ? '<div class="reader-meta">' + meta + '</div>' : '') + article.content + '</body>';
      // Marks the page as reader view (the theme check leaves it alone; restyled on theme changes).
      document.documentElement.setAttribute('data-stillweb-reader', '');
      var sheet = new CSSStyleSheet();
      sheet.replaceSync(${JSON.stringify(css)});
      document.adoptedStyleSheets = [sheet];
      window.scrollTo(0, 0);
      return true;
    } catch (e) {
      return false;
    }
  })()`;
}

/** Restyles a page already in reader view for the app's current theme (no reload). */
export function readerThemeScript(theme: Theme): string {
  return `(function () {
    if (!document.documentElement.hasAttribute('data-stillweb-reader')) return false;
    var sheet = new CSSStyleSheet();
    sheet.replaceSync(${JSON.stringify(readerCss(theme))});
    document.adoptedStyleSheets = [sheet];
    return true;
  })()`;
}
