// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*", "desktop/*", "native/shield-webview/ios/Resources/*", "native/shield-webview/android/*", "native/shield-webview/web/*"],
  },
  {
    // These two rules are written for the React Compiler, which the app does not use. The
    // browser mirrors its latest state in refs during render on purpose (stable callbacks,
    // no re-render of the whole browser for frequent native events), and resets per-tab
    // tools in an effect when the active tab changes.
    rules: {
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
]);
