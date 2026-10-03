import { useEffect, useState } from 'react';
import { Appearance, AppState, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ShieldEngine } from './native/shield-webview';
import { applyDevProxy } from './src/blocking/devProxy';
import { checkForFilterUpdate, registerFilterUpdateTask } from './src/blocking/filterUpdater';
import { LibraryProvider, useLibrary } from './src/browser/library';
import { SettingsProvider, useSettings } from './src/browser/settings';
import { TabsProvider } from './src/browser/tabs';
import BrowserScreen from './src/ui/screens/BrowserScreen';
import { useTheme } from './src/ui/theme';

/** Waits for settings so start-up privacy work happens before any page loads. */
function Root() {
  const { settings, loaded } = useSettings();
  const library = useLibrary();
  const theme = useTheme(settings.theme);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!loaded) return;
    (async () => {
      await applyDevProxy();
      // Private tabs are never restored, so anything left in the private profile (for
      // example after the app was killed) is wiped before browsing starts.
      await ShieldEngine.clearPrivateData().catch(() => {});
      if (settings.clearDataOnExit) {
        await ShieldEngine.clearBrowsingData().catch(() => {});
        library.clearHistory();
      }
      setReady(true);
    })();
    // Runs once, after settings load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  // The theme choice applies app-wide (dialogs, keyboards, and web views' dark mode too).
  useEffect(() => {
    Appearance.setColorScheme(settings.theme === 'system' ? 'unspecified' : settings.theme);
  }, [settings.theme]);

  // Filter updates: at launch, when returning to the app, and daily in the background.
  useEffect(() => {
    const check = () => checkForFilterUpdate().catch(() => {});
    check();
    registerFilterUpdateTask().catch(() => {});
    const sub = AppState.addEventListener('change', (state) => state === 'active' && check());
    return () => sub.remove();
  }, []);

  if (!ready) return <View style={{ flex: 1, backgroundColor: theme.background }} />;
  return (
    <TabsProvider clearOnStart={settings.clearDataOnExit}>
      <BrowserScreen />
    </TabsProvider>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <SettingsProvider>
        <LibraryProvider>
          <Root />
        </LibraryProvider>
      </SettingsProvider>
    </SafeAreaProvider>
  );
}
