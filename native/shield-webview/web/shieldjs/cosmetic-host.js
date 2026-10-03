// Host-specific cosmetic filtering. Injected at document start into frames of one
// hostname, with the config placeholder on the last line replaced by
//   { hide: [css selectors], procedural: [JSON strings from adblock-rust] }
// Shared by Android (addDocumentStartJavaScript) and iOS (WKUserScript).
(function (config) {
  'use strict';
  if (!config) return;

  var doc = document;
  var HIDE = 'display:none!important';
  var setTimeoutFn = window.setTimeout.bind(window);
  var clearTimeoutFn = window.clearTimeout.bind(window);
  var ObserverCtor = window.MutationObserver;

  // Constructable sheets are not subject to the page's style-src CSP.
  var sheet = null;
  function attachSheet() {
    try {
      if (!sheet) sheet = new CSSStyleSheet();
      var list = doc.adoptedStyleSheets;
      if (list.indexOf(sheet) === -1) doc.adoptedStyleSheets = list.concat([sheet]);
      return true;
    } catch (e) {
      return false;
    }
  }
  function addRule(selector, declarations) {
    if (!sheet && !attachSheet()) return;
    try {
      sheet.insertRule(selector + '{' + declarations + '}', sheet.cssRules.length);
    } catch (e) {
      // Invalid selectors are skipped one by one instead of breaking the whole sheet.
    }
  }

  (config.hide || []).forEach(function (selector) {
    addRule(selector, HIDE);
  });

  // ---- procedural filters ------------------------------------------------------
  var dynamic = [];
  (config.procedural || []).forEach(function (raw) {
    var filter;
    try {
      filter = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) {
      return;
    }
    var ops = filter.selector || [];
    var action = filter.action;
    if (ops.length === 1 && ops[0].type === 'css-selector' && (!action || action.type === 'style')) {
      addRule(ops[0].arg, action ? action.arg : HIDE);
    } else {
      dynamic.push(filter);
    }
  });

  if (!dynamic.length) return;

  function textMatcher(arg) {
    var m = /^\/(.+)\/([gimsu]*)$/.exec(arg);
    if (m) {
      try {
        var re = new RegExp(m[1], m[2]);
        return function (s) {
          return re.test(s);
        };
      } catch (e) {
        return function () {
          return false;
        };
      }
    }
    return function (s) {
      return s.indexOf(arg) !== -1;
    };
  }

  function propertyMatcher(arg) {
    // "name: value" or "name: /regex/"
    var i = arg.indexOf(':');
    if (i < 0) return null;
    return { name: arg.slice(0, i).trim(), test: textMatcher(arg.slice(i + 1).trim()) };
  }

  function startsWithCombinator(s) {
    return /^\s*[>+~ ]/.test(s);
  }

  function step(nodes, op) {
    var t = op.type;
    var a = op.arg;
    var out = [];
    var i;
    if (t === 'css-selector') {
      if (nodes === null) {
        try {
          return Array.prototype.slice.call(doc.querySelectorAll(a));
        } catch (e) {
          return [];
        }
      }
      for (i = 0; i < nodes.length; i++) {
        try {
          if (startsWithCombinator(a)) {
            var trimmed = a.replace(/^\s+/, '');
            if (trimmed[0] === '+' || trimmed[0] === '~') {
              var adjacentOnly = trimmed[0] === '+';
              var sibSelector = trimmed.slice(1).trim();
              for (var sib = nodes[i].nextElementSibling; sib; sib = sib.nextElementSibling) {
                if (sib.matches(sibSelector)) out.push(sib);
                if (adjacentOnly) break;
              }
            } else {
              out.push.apply(out, nodes[i].querySelectorAll(':scope ' + trimmed));
            }
          } else if (nodes[i].matches(a)) {
            out.push(nodes[i]);
          }
        } catch (e) {}
      }
      return out;
    }
    if (nodes === null) nodes = [doc.documentElement];
    if (t === 'has-text') {
      var match = textMatcher(a);
      return nodes.filter(function (n) {
        return match(n.textContent || '');
      });
    }
    if (t === 'min-text-length') {
      var min = parseInt(a, 10) || 0;
      return nodes.filter(function (n) {
        return (n.textContent || '').length >= min;
      });
    }
    if (t === 'upward') {
      var count = /^\d+$/.test(a) ? parseInt(a, 10) : 0;
      nodes.forEach(function (n) {
        var p = n;
        if (count) {
          for (var k = 0; k < count && p; k++) p = p.parentElement;
        } else {
          p = n.parentElement && n.parentElement.closest(a);
        }
        if (p && out.indexOf(p) === -1) out.push(p);
      });
      return out;
    }
    if (t === 'matches-css' || t === 'matches-css-before' || t === 'matches-css-after') {
      var pm = propertyMatcher(a);
      if (!pm) return [];
      var pseudo = t === 'matches-css' ? null : t === 'matches-css-before' ? '::before' : '::after';
      return nodes.filter(function (n) {
        return pm.test(String(getComputedStyle(n, pseudo).getPropertyValue(pm.name)));
      });
    }
    if (t === 'matches-attr') {
      var parts = /^"?(.+?)"?\s*=\s*"?(.*?)"?$/.exec(a);
      if (!parts) return [];
      var nameTest = textMatcher(parts[1]);
      var valueTest = textMatcher(parts[2]);
      return nodes.filter(function (n) {
        for (var k = 0; k < n.attributes.length; k++) {
          if (nameTest(n.attributes[k].name) && valueTest(n.attributes[k].value)) return true;
        }
        return false;
      });
    }
    if (t === 'matches-path') {
      return textMatcher(a)(location.pathname + location.search) ? nodes : [];
    }
    if (t === 'xpath') {
      nodes.forEach(function (n) {
        try {
          var snap = doc.evaluate(a, n, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          for (var k = 0; k < snap.snapshotLength; k++) {
            var el = snap.snapshotItem(k);
            if (el && el.nodeType === 1 && out.indexOf(el) === -1) out.push(el);
          }
        } catch (e) {}
      });
      return out;
    }
    return []; // unknown operator: match nothing rather than over-hide
  }

  function apply(node, action) {
    if (!action) {
      node.style.setProperty('display', 'none', 'important');
    } else if (action.type === 'remove') {
      node.remove();
    } else if (action.type === 'style') {
      node.setAttribute('style', (node.getAttribute('style') || '') + ';' + action.arg);
    } else if (action.type === 'remove-attr') {
      node.removeAttribute(action.arg);
    } else if (action.type === 'remove-class') {
      node.classList.remove(action.arg);
    }
  }

  function run() {
    dynamic.forEach(function (filter) {
      var nodes = null;
      for (var i = 0; i < filter.selector.length; i++) {
        nodes = step(nodes, filter.selector[i]);
        if (!nodes.length) return;
      }
      (nodes || []).forEach(function (n) {
        apply(n, filter.action);
      });
    });
  }

  var timer = 0;
  function schedule() {
    if (timer) return;
    timer = setTimeoutFn(function () {
      timer = 0;
      run();
    }, 120);
  }

  function start() {
    run();
    if (ObserverCtor) {
      new ObserverCtor(schedule).observe(doc.documentElement, { childList: true, subtree: true });
    }
    // Stop polling after the page settles to keep long sessions cheap.
    setTimeoutFn(function () {
      clearTimeoutFn(timer);
      run();
    }, 10000);
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})(__SHIELD_CONFIG__);
