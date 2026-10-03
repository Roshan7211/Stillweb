// Generic cosmetic filtering (rules like `##.ad-banner`). Injected at document start
// into every frame. Collects class names and ids as the DOM changes and asks the
// native engine which generic hide selectors apply; the native side answers with a
// JSON array of selectors (empty when shields are off or the site has $generichide).
//
// Transport is set by the native side before this script:
//   Android: window.__shieldBridge (WebViewCompat.addWebMessageListener)
//   iOS:     window.webkit.messageHandlers.shieldGeneric (WKScriptMessageHandlerWithReply)
(function () {
  'use strict';

  var send;
  var android = window.__shieldBridge;
  var iosHandler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.shieldGeneric;
  if (android) {
    var pending = [];
    android.onmessage = function (event) {
      var cb = pending.shift();
      if (cb) cb(event.data);
    };
    send = function (payload, cb) {
      pending.push(cb);
      android.postMessage(payload);
    };
    // Keep the bridge out of reach of page scripts.
    try {
      delete window.__shieldBridge;
    } catch (e) {}
  } else if (iosHandler) {
    send = function (payload, cb) {
      iosHandler.postMessage(payload).then(cb, function () {});
    };
  } else {
    return;
  }

  var doc = document;
  var setTimeoutFn = window.setTimeout.bind(window);
  var ObserverCtor = window.MutationObserver;
  var HIDE = 'display:none!important';

  var sheet = null;
  function addRules(selectors) {
    try {
      if (!sheet) sheet = new CSSStyleSheet();
      if (doc.adoptedStyleSheets.indexOf(sheet) === -1) {
        doc.adoptedStyleSheets = doc.adoptedStyleSheets.concat([sheet]);
      }
    } catch (e) {
      return;
    }
    for (var i = 0; i < selectors.length; i++) {
      try {
        sheet.insertRule(selectors[i] + '{' + HIDE + '}', sheet.cssRules.length);
      } catch (e) {}
    }
  }

  var seenClasses = new Set();
  var seenIds = new Set();
  var newClasses = [];
  var newIds = [];
  var timer = 0;
  var disabled = false;

  function collect(el) {
    var id = el.id;
    if (id && typeof id === 'string' && !seenIds.has(id)) {
      seenIds.add(id);
      newIds.push(id);
    }
    var list = el.classList;
    if (list) {
      for (var i = 0; i < list.length; i++) {
        if (!seenClasses.has(list[i])) {
          seenClasses.add(list[i]);
          newClasses.push(list[i]);
        }
      }
    }
  }

  function scan(root) {
    if (!root || root.nodeType !== 1) return;
    collect(root);
    var all = root.querySelectorAll('[id],[class]');
    for (var i = 0; i < all.length; i++) collect(all[i]);
  }

  function flush() {
    timer = 0;
    if (disabled || (!newClasses.length && !newIds.length)) return;
    var payload = JSON.stringify({ classes: newClasses, ids: newIds });
    newClasses = [];
    newIds = [];
    send(payload, function (reply) {
      var result;
      try {
        result = typeof reply === 'string' ? JSON.parse(reply) : reply;
      } catch (e) {
        return;
      }
      // `null` means generic hiding does not apply here; stop observing.
      if (result === null) {
        disabled = true;
        return;
      }
      if (result && result.length) addRules(result);
    });
  }

  function schedule(delay) {
    if (!timer) timer = setTimeoutFn(flush, delay);
  }

  if (ObserverCtor) {
    new ObserverCtor(function (mutations) {
      if (disabled) return;
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        if (m.type === 'attributes') {
          collect(m.target);
        } else {
          for (var j = 0; j < m.addedNodes.length; j++) scan(m.addedNodes[j]);
        }
      }
      schedule(50);
    }).observe(doc, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'id'] });
  }

  if (doc.documentElement) scan(doc.documentElement);
  schedule(0);
})();
