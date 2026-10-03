// Injected at document start into every frame. Signals Global Privacy Control
// (https://globalprivacycontrol.org): sites must treat it as an opt-out of sale/sharing
// of personal data where the law recognises it.
(function () {
  'use strict';
  try {
    Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', {
      get: function () {
        return true;
      },
      configurable: true,
      enumerable: true,
    });
  } catch (e) {}
})();
