import { reloadAppAsync } from 'expo';
import { useEffect, useState } from 'react';
import { Appearance, AppState, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ShieldEngine } from './native/shield-webview';
import { applyDevProxy } from './src/blocking/devProxy';
import { checkForFilterUpdate, registerFilterUpdateTask } from './src/blocking/filterUpdater';
import { LibraryProvider, useLibrary } from './src/browser/library';
import { PrivacyStatsProvider, usePrivacyStatsActions } from './src/browser/privacyStats';
import { SettingsProvider, useSettings } from './src/browser/settings';
import { TabsProvider } from './src/browser/tabs';
import { installGlobalErrorHandler, markAppReady } from './src/errors';
import { PlusProvider, usePlus } from './src/plus/plus';
import { ErrorBoundary, ErrorNotice, ProblemScreen } from './src/ui/components/ErrorBoundary';
import BrowserScreen from './src/ui/screens/BrowserScreen';
import { useTheme } from './src/ui/theme';

installGlobalErrorHandler();

const restart = () => {
  reloadAppAsync('Restart after an error').catch(() => {});
};

/** Waits for settings so start-up privacy work happens before any page loads. */
function Root() {
  const { settings, loaded } = useSettings();
  const library = useLibrary();
  const stats = usePrivacyStatsActions();
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
        stats.clear();
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

  useEffect(() => {
    if (ready) markAppReady();
  }, [ready]);

  // Plus features reach the native side only while Plus is active.
  const plus = usePlus();
  const calmMode = settings.shields.calmMode && plus.unlocked;
  useEffect(() => {
    ShieldEngine.setOptions({ calmMode });
  }, [calmMode]);

  if (!ready) return <View style={{ flex: 1, backgroundColor: theme.background }} />;
  return (
    <TabsProvider clearOnStart={settings.clearDataOnExit}>
      {/* Tabs live above this boundary, so trying again keeps them. */}
      <ErrorBoundary
        fallback={(reset) => (
          <ProblemScreen
            theme={theme}
            title="Something went wrong"
            body="Stillweb ran into a problem. Your tabs and bookmarks are safe."
            primary={{ label: 'Try again', onPress: reset }}
            secondary={{ label: 'Restart Stillweb', onPress: restart }}
          />
        )}>
        <BrowserScreen />
      </ErrorBoundary>
      <ErrorNotice theme={theme} onRestart={restart} />
    </TabsProvider>
  );
}

/** Shown if even settings or storage fail to start. */
function StartupProblem() {
  const theme = useTheme();
  return (
    <ProblemScreen
      theme={theme}
      title="Stillweb couldn’t start"
      body="Something went wrong while opening the app. Restarting usually fixes it."
      primary={{ label: 'Restart Stillweb', onPress: restart }}
    />
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <ErrorBoundary fallback={() => <StartupProblem />}>
        <SettingsProvider>
          <LibraryProvider>
            <PrivacyStatsProvider>
              <PlusProvider>
                <Root />
              </PlusProvider>
            </PrivacyStatsProvider>
          </LibraryProvider>
        </SettingsProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
