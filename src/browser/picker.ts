/**
 * "Hide an element" (Stillweb Plus): page-side picker. The app starts it, the user taps what
 * to hide (taps select instead of following links), "Bigger" widens the selection to the
 * enclosing element, and "Hide" returns a CSS selector for it, which the app saves for the
 * site and the native side hides on every visit.
 */

const PICKER = `(function () {
  if (window.__stillwebPicker) return window.__stillwebPicker;
  var box = document.createElement('div');
  box.setAttribute('data-stillweb', 'picker');
  box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #2F6FEB;' +
    'background:rgba(47,111,235,0.18);border-radius:4px;display:none;box-sizing:border-box;transition:all .08s';
  var current = null;

  function place() {
    if (!current || !current.isConnected) { box.style.display = 'none'; return; }
    var r = current.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = Math.max(r.width, 4) + 'px';
    box.style.height = Math.max(r.height, 4) + 'px';
  }
  function select(el) {
    if (!el || el === box || el === document.documentElement || el === document.body) return;
    current = el;
    place();
  }
  function pick(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    var t = e.changedTouches && e.changedTouches[0] ? e.changedTouches[0] : e;
    box.style.display = 'none';
    select(document.elementFromPoint(t.clientX, t.clientY));
  }
  function swallow(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  }

  // Generated class names (css-1x2y3z, sc-abcdef, hashes) change between visits.
  function stableClass(c) {
    return /^[A-Za-z_-][A-Za-z0-9_-]*$/.test(c) && !/\\d{3,}/.test(c) && !/^(css|sc|jsx|tw|svelte|emotion)-/.test(c) &&
      !(/[a-z]/.test(c) && /[A-Z]/.test(c) && /\\d/.test(c) && c.length >= 6);
  }
  function part(el) {
    if (el.id && /^[A-Za-z][A-Za-z0-9_-]*$/.test(el.id) && !/\\d{3,}/.test(el.id)) return '#' + el.id;
    var s = el.tagName.toLowerCase();
    var classes = Array.prototype.filter.call(el.classList, stableClass).slice(0, 3);
    if (classes.length) s += '.' + classes.join('.');
    return s;
  }
  function unique(sel) {
    try { return document.querySelectorAll(sel).length === 1; } catch (e) { return false; }
  }
  function nth(el) {
    var i = 1, sib = el;
    while ((sib = sib.previousElementSibling)) if (sib.tagName === el.tagName) i++;
    return el.tagName.toLowerCase() + ':nth-of-type(' + i + ')';
  }
  function selectorFor(el) {
    var parts = [];
    for (var node = el; node && node.nodeType === 1 && node !== document.body && node !== document.documentElement; node = node.parentElement) {
      parts.unshift(part(node));
      var sel = parts.join(' > ');
      if (unique(sel) && document.querySelector(sel) === el) return sel;
    }
    // No short unique path: the exact position from the body down.
    var path = [];
    for (node = el; node && node.nodeType === 1 && node !== document.body && node !== document.documentElement; node = node.parentElement) {
      path.unshift(nth(node));
    }
    return 'body > ' + path.join(' > ');
  }

  var events = ['click', 'touchend', 'mouseup'];
  var blocked = ['touchstart', 'mousedown', 'pointerdown', 'pointerup', 'auxclick', 'submit'];
  function stop() {
    events.forEach(function (t) { window.removeEventListener(t, pick, true); });
    blocked.forEach(function (t) { window.removeEventListener(t, swallow, true); });
    window.removeEventListener('scroll', place, true);
    window.removeEventListener('resize', place, true);
    if (box.parentNode) box.parentNode.removeChild(box);
    current = null;
    delete window.__stillwebPicker;
  }
  events.forEach(function (t) { window.addEventListener(t, pick, true); });
  blocked.forEach(function (t) { window.addEventListener(t, swallow, true); });
  window.addEventListener('scroll', place, true);
  window.addEventListener('resize', place, true);
  (document.body || document.documentElement).appendChild(box);

  window.__stillwebPicker = {
    bigger: function () {
      if (current && current.parentElement && current.parentElement !== document.body) select(current.parentElement);
      return !!current;
    },
    finish: function () {
      if (!current) return null;
      var sel = selectorFor(current);
      var style = document.createElement('style');
      style.setAttribute('data-stillweb', 'hidden');
      style.textContent = sel + ' { display: none !important; }';
      (document.head || document.documentElement).appendChild(style);
      stop();
      return sel;
    },
    cancel: function () { stop(); return true; }
  };
  return window.__stillwebPicker;
})();`;

export function pickerStartScript(): string {
  return `${PICKER} true`;
}

export function pickerBiggerScript(): string {
  return '(function(){return window.__stillwebPicker ? window.__stillwebPicker.bigger() : false;})()';
}

/** Resolves (as JSON) to the selector of what was hidden, or null if nothing was picked. */
export function pickerFinishScript(): string {
  return '(function(){return window.__stillwebPicker ? window.__stillwebPicker.finish() : null;})()';
}

export function pickerCancelScript(): string {
  return '(function(){return window.__stillwebPicker ? window.__stillwebPicker.cancel() : true;})()';
}
