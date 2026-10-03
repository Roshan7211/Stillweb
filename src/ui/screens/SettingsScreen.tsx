import * as LocalAuthentication from 'expo-local-authentication';
import { useEffect, useState } from 'react';
import { Alert, Linking, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ShieldEngine, type EngineStatus } from '../../../native/shield-webview';
import { FILTER_MANIFEST_URL } from '../../blocking/config';
import { checkForFilterUpdate } from '../../blocking/filterUpdater';
import { useLibrary } from '../../browser/library';
import { useSettings } from '../../browser/settings';
import { SEARCH_ENGINES } from '../../browser/url';
import { Icon, IconButton, Row, ScreenHeader, SectionTitle, SwitchRow } from '../components/primitives';
import type { Theme } from '../theme';

type Props = {
  theme: Theme;
  onBack: () => void;
  onOpenAbout: () => void;
  onOpenShieldTest: () => void;
  onClearedData: () => void;
};

function formatVersion(v: string | null | undefined): string {
  if (!v) return 'not loaded';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export default function SettingsScreen({ theme, onBack, onOpenAbout, onOpenShieldTest, onClearedData }: Props) {
  const { settings, update, setSiteShields } = useSettings();
  const library = useLibrary();
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [updating, setUpdating] = useState(false);
  const [updateMessage, setUpdateMessage] = useState('');
  const [showEngines, setShowEngines] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    ShieldEngine.getStatus().then(setStatus);
    const sub = ShieldEngine.addListener('onEngineChanged', setStatus);
    return () => sub.remove();
  }, []);

  const shields = settings.shields;

  const checkUpdates = async () => {
    setUpdating(true);
    setUpdateMessage('');
    try {
      const result = await checkForFilterUpdate({ force: true });
      setUpdateMessage(
        result.status === 'updated'
          ? 'Filters updated.'
          : result.status === 'up-to-date'
            ? 'Filters are up to date.'
            : 'No update server is configured; using the filters built into the app.',
      );
    } catch (e) {
      setUpdateMessage(`Update failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setUpdating(false);
    }
  };

  const toggleLock = async (value: boolean) => {
    if (value) {
      const [hardware, enrolled] = await Promise.all([
        LocalAuthentication.hasHardwareAsync(),
        LocalAuthentication.isEnrolledAsync(),
      ]);
      if (!hardware || !enrolled) {
        Alert.alert('Set up a screen lock first', 'Add a fingerprint, face or PIN in your device settings to lock private tabs.');
        return;
      }
      const result = await LocalAuthentication.authenticateAsync({ promptMessage: 'Lock private tabs' });
      if (!result.success) return;
    }
    update({ lockPrivateTabs: value });
  };

  const clearAll = () =>
    Alert.alert('Clear browsing data?', 'Deletes cookies, site data, cache and history.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear',
        style: 'destructive',
        onPress: async () => {
          await ShieldEngine.clearBrowsingData();
          library.clearHistory();
          onClearedData();
          Alert.alert('Browsing data cleared');
        },
      },
    ]);

  const engineLabel =
    settings.searchEngine === 'custom' ? 'Custom' : (SEARCH_ENGINES.find((e) => e.id === settings.searchEngine)?.label ?? '');
  const disabled = !shields.enabled;

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: theme.background }]} edges={['top', 'bottom', 'left', 'right']}>
      <ScreenHeader title="Settings" onBack={onBack} theme={theme} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <SectionTitle theme={theme}>Protection</SectionTitle>
        <SwitchRow
          title="Block ads and trackers"
          subtitle={`${(status?.totalBlocked ?? 0).toLocaleString()} blocked so far`}
          value={shields.enabled}
          onValueChange={(v) => update({ shields: { enabled: v } })}
          theme={theme}
        />
        {settings.disabledSites.length ? (
          <>
            <Text style={[styles.subhead, { color: theme.muted }]}>Turned off for these sites</Text>
            {settings.disabledSites.map((site) => (
              <Row
                key={site}
                title={site}
                theme={theme}
                icon="shield-off"
                right={
                  <IconButton
                    name="x"
                    label={`Turn protection back on for ${site}`}
                    size={18}
                    color={theme.muted}
                    onPress={() => setSiteShields(site, true)}
                  />
                }
              />
            ))}
          </>
        ) : null}

        <SectionTitle theme={theme}>Search</SectionTitle>
        <Row
          title="Search engine"
          subtitle={engineLabel}
          icon="search"
          theme={theme}
          onPress={() => setShowEngines((v) => !v)}
          right={<Icon name={showEngines ? 'chevron-up' : 'chevron-down'} size={20} color={theme.muted} />}
        />
        {showEngines ? (
          <>
            {SEARCH_ENGINES.map((engine) => (
              <Row
                key={engine.id}
                title={engine.label}
                theme={theme}
                onPress={() => update({ searchEngine: engine.id })}
                right={settings.searchEngine === engine.id ? <Icon name="check" size={20} color={theme.accent} /> : null}
              />
            ))}
            <Row
              title="Custom"
              subtitle="Any search address with %s for the query"
              theme={theme}
              onPress={() => update({ searchEngine: 'custom' })}
              right={settings.searchEngine === 'custom' ? <Icon name="check" size={20} color={theme.accent} /> : null}
            />
            {settings.searchEngine === 'custom' ? (
              <TextInput
                style={[styles.input, { color: theme.text, borderColor: theme.border }]}
                value={settings.customSearchTemplate}
                onChangeText={(t) => update({ customSearchTemplate: t })}
                placeholder="https://example.com/search?q=%s"
                placeholderTextColor={theme.muted}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />
            ) : null}
          </>
        ) : null}

        <SectionTitle theme={theme}>Media</SectionTitle>
        <SwitchRow
          title="Play in background"
          subtitle="Keep music and videos playing when you leave the app or lock the screen"
          value={shields.backgroundPlay}
          onValueChange={(v) => update({ shields: { backgroundPlay: v } })}
          theme={theme}
        />

        <SectionTitle theme={theme}>Look</SectionTitle>
        <View style={styles.segment}>
          {(['system', 'light', 'dark'] as const).map((mode) => (
            <Text
              key={mode}
              onPress={() => update({ theme: mode })}
              accessibilityRole="button"
              accessibilityState={{ selected: settings.theme === mode }}
              style={[
                styles.segmentItem,
                {
                  color: settings.theme === mode ? '#FFFFFF' : theme.text,
                  backgroundColor: settings.theme === mode ? theme.accent : theme.surface,
                },
              ]}>
              {mode === 'system' ? 'Automatic' : mode === 'light' ? 'Light' : 'Dark'}
            </Text>
          ))}
        </View>

        <SectionTitle theme={theme}>Privacy</SectionTitle>
        <SwitchRow
          title="Clear data on exit"
          subtitle="Start fresh every time: closes tabs and deletes cookies, cache and history"
          value={settings.clearDataOnExit}
          onValueChange={(v) => update({ clearDataOnExit: v })}
          theme={theme}
        />
        <SwitchRow
          title="Lock private tabs"
          subtitle={Platform.OS === 'ios' ? 'Use Face ID or Touch ID to open private tabs' : 'Use your fingerprint or screen lock to open private tabs'}
          value={settings.lockPrivateTabs}
          onValueChange={toggleLock}
          theme={theme}
        />
        <Row title="Clear browsing data now" icon="trash-2" theme={theme} danger onPress={clearAll} />

        {Platform.OS === 'android' ? (
          <>
            <SectionTitle theme={theme}>Default browser</SectionTitle>
            <Row
              title="Open links with this browser"
              subtitle="Choose it as your default browser in system settings"
              icon="globe"
              theme={theme}
              onPress={() =>
                Linking.sendIntent('android.settings.MANAGE_DEFAULT_APPS_SETTINGS').catch(() => Linking.openSettings())
              }
            />
          </>
        ) : null}

        <SectionTitle theme={theme}>More</SectionTitle>
        <Row
          title="Advanced settings"
          icon="sliders"
          theme={theme}
          onPress={() => setShowAdvanced((v) => !v)}
          right={<Icon name={showAdvanced ? 'chevron-up' : 'chevron-down'} size={20} color={theme.muted} />}
        />
        {showAdvanced ? (
          <>
            <SwitchRow
              title="Hide cookie banners"
              subtitle={Platform.OS === 'ios' ? 'Included in the built-in filters on this device' : undefined}
              value={shields.hideCookieBanners}
              onValueChange={(v) => update({ shields: { hideCookieBanners: v } })}
              theme={theme}
              disabled={Platform.OS === 'ios' || disabled}
            />
            <SwitchRow
              title="Block pop-ups and redirects"
              value={shields.blockPopups}
              onValueChange={(v) => update({ shields: { blockPopups: v } })}
              theme={theme}
              disabled={disabled}
            />
            <SwitchRow
              title="Always use secure connections"
              subtitle="Upgrades sites to HTTPS when they support it"
              value={shields.httpsUpgrade}
              onValueChange={(v) => update({ shields: { httpsUpgrade: v } })}
              theme={theme}
            />
            {Platform.OS === 'android' ? (
              <>
                <SwitchRow
                  title="Hide empty ad spaces"
                  value={shields.cosmeticFiltering}
                  onValueChange={(v) => update({ shields: { cosmeticFiltering: v } })}
                  theme={theme}
                  disabled={disabled}
                />
                <SwitchRow
                  title="Block cross-site cookies"
                  subtitle="Stops sites tracking you across other sites. Applies to new tabs"
                  value={shields.blockThirdPartyCookies}
                  onValueChange={(v) => update({ shields: { blockThirdPartyCookies: v } })}
                  theme={theme}
                />
              </>
            ) : null}
            <SwitchRow
              title="Dark pages"
              subtitle="Darken websites that have no dark theme while the app is dark"
              value={settings.darkPages}
              onValueChange={(v) => update({ darkPages: v })}
              theme={theme}
            />
            <Row
              title="Text size"
              subtitle={`${settings.textZoom}%`}
              theme={theme}
              right={
                <View style={styles.stepper}>
                  <IconButton name="minus" label="Smaller text" color={theme.text} onPress={() => update({ textZoom: Math.max(70, settings.textZoom - 10) })} />
                  <IconButton name="plus" label="Larger text" color={theme.text} onPress={() => update({ textZoom: Math.min(200, settings.textZoom + 10) })} />
                </View>
              }
            />
            <Row
              title={`Filters from ${formatVersion(status?.version)}`}
              subtitle={
                status?.lastError
                  ? `Problem: ${status.lastError}`
                  : `${status?.source === 'downloaded' ? 'Downloaded update' : 'Built into the app'}${FILTER_MANIFEST_URL ? ' · updates daily' : ''}`
              }
              icon="layers"
              theme={theme}
            />
            <Row
              title={updating ? 'Checking for updates…' : 'Check for filter updates'}
              subtitle={updateMessage || undefined}
              icon="refresh-cw"
              theme={theme}
              onPress={updating ? undefined : checkUpdates}
            />
            <Row title="Test blocking" subtitle="Open the ad block test page" icon="activity" theme={theme} onPress={onOpenShieldTest} />
          </>
        ) : null}
        <Row title="About and licenses" icon="info" theme={theme} onPress={onOpenAbout} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingBottom: 40 },
  subhead: { fontSize: 13, paddingHorizontal: 16, paddingTop: 10 },
  input: { marginHorizontal: 16, marginBottom: 8, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 12, height: 44, fontSize: 15 },
  segment: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 8 },
  segmentItem: { flex: 1, textAlign: 'center', paddingVertical: 10, borderRadius: 10, overflow: 'hidden', fontWeight: '600' },
  stepper: { flexDirection: 'row' },
});
