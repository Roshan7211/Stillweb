import * as LocalAuthentication from 'expo-local-authentication';
import { useEffect, useRef, useState } from 'react';
import { Alert, Image, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ShieldEngine, type EngineStatus } from '../../../native/shield-webview';
import { useLibraryActions } from '../../browser/library';
import { usePrivacyStatsActions } from '../../browser/privacyStats';
import { useSettings } from '../../browser/settings';
import { SEARCH_ENGINES } from '../../browser/url';
import { usePlus } from '../../plus/plus';
import { fromPerMonth } from '../../plus/pricing';
import { Group, Icon, IconButton, readable, Row, ScreenHeader, SectionTitle, SwitchRow } from '../components/primitives';
import { authenticate } from '../authenticate';
import ProfilesSection from '../components/ProfilesSection';
import { ACCENTS, type AccentId, type Theme } from '../theme';

type Props = {
  theme: Theme;
  onBack: () => void;
  onOpenAbout: () => void;
  onOpenPlus: () => void;
  onOpenReport: () => void;
  onClearedData: () => void;
};

// Where the screen was left for one of its own pages (About, the report, the test…): coming back
// from there shows the same place again. Leaving Settings itself starts over.
const place = { y: 0 };
/** Settings was left altogether (also by the system's back key): next time it starts at the top. */
export function forgetSettingsPlace() {
  place.y = 0;
}

export default function SettingsScreen({ theme, onBack, onOpenAbout, onOpenPlus, onOpenReport, onClearedData }: Props) {
  const { settings, update, setSiteShields, setSiteFix } = useSettings();
  const library = useLibraryActions();
  const stats = usePrivacyStatsActions();
  const plus = usePlus();
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [showEngines, setShowEngines] = useState(false);
  const scroll = useRef<ScrollView>(null);
  const restored = useRef(false);
  // Where the screen starts, fixed when it opens (it must not follow the scrolling).
  const [startAt] = useState(() => (place.y > 0 ? { x: 0, y: place.y } : undefined));
  const leave = () => {
    forgetSettingsPlace();
    onBack();
  };

  // The Plus row shows the starting price once the App Store has the plans.
  const { supported: plusSupported, productsState, loadProducts } = plus;
  useEffect(() => {
    if (plusSupported && !plus.entitlement && productsState === 'idle') loadProducts();
    // When Settings opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const fromPrice = productsState === 'ready' ? fromPerMonth(plus.products) : null;

  useEffect(() => {
    ShieldEngine.getStatus().then(setStatus).catch(() => {});
    const sub = ShieldEngine.addListener('onEngineChanged', setStatus);
    return () => sub.remove();
  }, []);

  const shields = settings.shields;

  const toggleLock = async (value: boolean) => {
    if (value) {
      try {
        const [hardware, enrolled] = await Promise.all([
          LocalAuthentication.hasHardwareAsync(),
          LocalAuthentication.isEnrolledAsync(),
        ]);
        if (!hardware || !enrolled) {
          Alert.alert('Set up a screen lock first', 'Add a fingerprint, face or PIN in your device settings to lock private tabs.');
          return;
        }
        const result = await authenticate('Lock private tabs');
        if (!result.success) return;
      } catch {
        Alert.alert(
          'Couldn’t turn on the lock',
          Platform.OS === 'ios'
            ? 'Face ID or the passcode isn’t available right now. Try again.'
            : 'Your fingerprint or screen lock isn’t available right now. Try again.',
        );
        return;
      }
    }
    update({ lockPrivateTabs: value });
  };

  const clearAll = () =>
    Alert.alert('Clear browsing data?', `Deletes cookies, site data, cache and history${settings.profiles.length ? ' in every profile' : ''}.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear',
        style: 'destructive',
        onPress: async () => {
          try {
            await ShieldEngine.clearBrowsingData();
          } catch {
            Alert.alert('Couldn’t clear everything', 'Some website data may be left. Try again.');
            return;
          }
          library.clearHistory();
          stats.clear();
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
      <ScreenHeader title="Settings" onBack={leave} theme={theme} />
      <ScrollView
        ref={scroll}
        contentContainerStyle={[readable, styles.content]}
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={64}
        onScroll={(e) => {
          place.y = e.nativeEvent.contentOffset.y;
        }}
        // Back from one of its own pages: at the place it was left.
        contentOffset={startAt}
        onContentSizeChange={() => {
          if (startAt && !restored.current) {
            restored.current = true;
            scroll.current?.scrollTo({ y: startAt.y, animated: false });
          }
        }}>
        {plus.supported ? (
          <Group theme={theme} style={styles.firstGroup}>
            <Row
              title="Stillweb Plus"
              subtitle={
                plus.entitlement
                  ? 'Active. Thank you for supporting Stillweb'
                  : fromPrice
                    ? `Get more out of Stillweb, from ${fromPrice} a month`
                    : 'Get more out of Stillweb'
              }
              icon="star"
              theme={theme}
              onPress={onOpenPlus}
              right={<Icon name="chevron-right" size={20} color={theme.muted} />}
            />
          </Group>
        ) : null}

        <SectionTitle theme={theme}>Protection</SectionTitle>
        <Group theme={theme}>
          <SwitchRow
            title="Block ads and trackers"
            subtitle={`${(status?.totalBlocked ?? 0).toLocaleString()} blocked so far`}
            value={shields.enabled}
            onValueChange={(v) => update({ shields: { enabled: v } })}
            theme={theme}
          />
          <SwitchRow
            title={plus.unlocked ? 'Calm Mode' : 'Calm Mode · Plus'}
            subtitle="Rejects cookie pop-ups and hides chat bubbles, floating videos and more"
            value={shields.calmMode && plus.unlocked}
            onValueChange={(v) => (plus.unlocked ? update({ shields: { calmMode: v } }) : onOpenPlus())}
            theme={theme}
            disabled={disabled}
          />
          <Row
            title="Privacy report"
            subtitle="What was blocked, day by day"
            icon="bar-chart-2"
            theme={theme}
            onPress={onOpenReport}
            right={<Icon name="chevron-right" size={20} color={theme.muted} />}
          />
        </Group>

        {settings.disabledSites.length ? (
          <>
            <SectionTitle theme={theme}>Turned off for these sites</SectionTitle>
            <Group theme={theme}>
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
            </Group>
          </>
        ) : null}

        {Object.keys(settings.siteFixes).length ? (
          <>
            <SectionTitle theme={theme}>Site changes</SectionTitle>
            <Group theme={theme}>
              {Object.entries(settings.siteFixes).map(([site, fix]) => (
                <Row
                  key={site}
                  title={site}
                  subtitle={[
                    fix.desktop ? 'Desktop website' : null,
                    fix.noScript ? 'Interactive content off' : null,
                    fix.hidden?.length ? `${fix.hidden.length} hidden ${fix.hidden.length === 1 ? 'item' : 'items'}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  theme={theme}
                  icon="tool"
                  right={
                    <IconButton name="x" label={`Undo changes for ${site}`} size={18} color={theme.muted} onPress={() => setSiteFix(site, null)} />
                  }
                />
              ))}
            </Group>
          </>
        ) : null}

        <SectionTitle theme={theme}>Search</SectionTitle>
        <Group theme={theme}>
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
                subtitle="Your own search site: put %s where the search words go"
                theme={theme}
                onPress={() => update({ searchEngine: 'custom' })}
                right={settings.searchEngine === 'custom' ? <Icon name="check" size={20} color={theme.accent} /> : null}
              />
              {settings.searchEngine === 'custom' ? (
                <TextInput
                  style={[styles.input, { color: theme.text, borderColor: theme.border, backgroundColor: theme.background }]}
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

        </Group>

        <SectionTitle theme={theme}>Media</SectionTitle>
        <Group theme={theme}>
          <SwitchRow
            title={plus.unlocked ? 'Play in background' : 'Play in background · Plus'}
            subtitle="Keep music and videos playing when you leave the app or lock the screen"
            value={shields.backgroundPlay && plus.unlocked}
            onValueChange={(v) => (plus.unlocked ? update({ shields: { backgroundPlay: v } }) : onOpenPlus())}
            theme={theme}
          />
        </Group>

        <SectionTitle theme={theme}>Look</SectionTitle>
        <Group theme={theme}>
          <Text style={[styles.subhead, { color: theme.muted }]}>Appearance</Text>
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
                    backgroundColor: settings.theme === mode ? theme.accent : theme.background,
                  },
                ]}>
                {mode === 'system' ? 'Automatic' : mode === 'light' ? 'Light' : 'Dark'}
              </Text>
            ))}
          </View>

          <Text style={[styles.subhead, { color: theme.muted }]}>Accent color{plus.unlocked ? '' : ' · Plus'}</Text>
          <View style={styles.swatches}>
            {(Object.keys(ACCENTS) as AccentId[]).map((id) => {
              const selected = (plus.unlocked ? settings.accent : 'blue') === id;
              return (
                <Pressable
                  key={id}
                  onPress={() => (plus.unlocked ? update({ accent: id }) : onOpenPlus())}
                  accessibilityRole="button"
                  accessibilityLabel={ACCENTS[id].label}
                  accessibilityState={{ selected }}
                  style={[
                    styles.swatch,
                    { backgroundColor: ACCENTS[id][theme.dark ? 'dark' : 'light'].accent, borderColor: selected ? theme.text : 'transparent' },
                  ]}>
                  {selected ? <Icon name="check" size={18} color="#FFFFFF" /> : null}
                </Pressable>
              );
            })}
          </View>
          {Platform.OS === 'ios' ? <AppIconPicker theme={theme} unlocked={plus.unlocked} onLocked={onOpenPlus} /> : null}

          <Text style={[styles.subhead, { color: theme.muted }]}>Address bar</Text>
          <View style={[styles.segment, styles.lastInGroup]}>
            {(['single', 'bottom', 'top'] as const).map((position) => (
              <Text
                key={position}
                onPress={() => update({ addressBarPosition: position })}
                accessibilityRole="button"
                accessibilityState={{ selected: settings.addressBarPosition === position }}
                style={[
                  styles.segmentItem,
                  {
                    color: settings.addressBarPosition === position ? '#FFFFFF' : theme.text,
                    backgroundColor: settings.addressBarPosition === position ? theme.accent : theme.background,
                  },
                ]}>
                {position === 'single' ? 'Single bar' : position === 'bottom' ? 'Bottom' : 'Top'}
              </Text>
            ))}
          </View>
        </Group>

        <SectionTitle theme={theme}>Privacy</SectionTitle>
        <Group theme={theme}>
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
          <SwitchRow
            title={plus.unlocked ? 'Private vault' : 'Private vault · Plus'}
            subtitle={
              Platform.OS === 'ios'
                ? 'Bookmarks and downloads from private tabs are kept in a vault locked with Face ID'
                : 'Bookmarks from private tabs are kept in a vault locked with your screen lock'
            }
            value={settings.vault && plus.unlocked}
            onValueChange={(v) => (plus.unlocked ? update({ vault: v }) : onOpenPlus())}
            theme={theme}
          />
          <Row title="Clear browsing data now" icon="trash-2" theme={theme} danger onPress={clearAll} />
        </Group>

        <ProfilesSection theme={theme} unlocked={plus.unlocked} onOpenPlus={onOpenPlus} />

        {Platform.OS === 'android' ? (
          <>
            <SectionTitle theme={theme}>Default browser</SectionTitle>
            <Group theme={theme}>
              <Row
                title="Open links with this browser"
                subtitle="Choose it as your default browser in system settings"
                icon="globe"
                theme={theme}
                onPress={() =>
                  Linking.sendIntent('android.settings.MANAGE_DEFAULT_APPS_SETTINGS').catch(() => Linking.openSettings())
                }
              />
            </Group>
          </>
        ) : null}

        {/* The options that were under Advanced settings stay at their defaults (see FIXED in settings.tsx). */}
        <SectionTitle theme={theme}>More</SectionTitle>
        <Group theme={theme}>
          <Row title="About and licenses" icon="info" theme={theme} onPress={onOpenAbout} />
        </Group>
      </ScrollView>
    </SafeAreaView>
  );
}

/** Stillweb Plus app icons (iOS; images from scripts/gen-alt-icons.py). */
const APP_ICONS: { name: string; preview: number }[] = [
  { name: 'Standard', preview: require('../../../assets/alt-icons/previews/Standard.png') },
  { name: 'Midnight', preview: require('../../../assets/alt-icons/previews/Midnight.png') },
  { name: 'Sunset', preview: require('../../../assets/alt-icons/previews/Sunset.png') },
  { name: 'Forest', preview: require('../../../assets/alt-icons/previews/Forest.png') },
  { name: 'Violet', preview: require('../../../assets/alt-icons/previews/Violet.png') },
];

function AppIconPicker({ theme, unlocked, onLocked }: { theme: Theme; unlocked: boolean; onLocked: () => void }) {
  const [current, setCurrent] = useState('Standard');
  useEffect(() => {
    ShieldEngine.getAppIcon()
      .then((name) => setCurrent(name ?? 'Standard'))
      .catch(() => {});
  }, []);

  const choose = (name: string) => {
    if (!unlocked) return onLocked();
    if (name === current) return;
    ShieldEngine.setAppIcon(name === 'Standard' ? null : name)
      .then((ok) => (ok ? setCurrent(name) : Alert.alert('The icon couldn’t be changed', 'Try again in a moment.')))
      .catch(() => Alert.alert('The icon couldn’t be changed', 'Try again in a moment.'));
  };

  return (
    <>
      <Text style={[styles.subhead, { color: theme.muted }]}>App icon{unlocked ? '' : ' · Plus'}</Text>
      <View style={styles.icons}>
        {APP_ICONS.map((icon) => (
          <Pressable
            key={icon.name}
            onPress={() => choose(icon.name)}
            accessibilityRole="button"
            accessibilityLabel={`${icon.name} app icon`}
            accessibilityState={{ selected: current === icon.name }}
            style={styles.iconChoice}>
            <Image
              source={icon.preview}
              style={[styles.iconImage, { borderColor: current === icon.name ? theme.accent : 'transparent' }]}
            />
            <Text style={[styles.iconLabel, { color: current === icon.name ? theme.text : theme.muted }]}>{icon.name}</Text>
          </Pressable>
        ))}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  swatches: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16, paddingVertical: 10 },
  swatch: { width: 34, height: 34, borderRadius: 17, borderWidth: 2.5, alignItems: 'center', justifyContent: 'center' },
  icons: { flexDirection: 'row', flexWrap: 'wrap', gap: 14, paddingHorizontal: 16, paddingVertical: 10 },
  iconChoice: { alignItems: 'center', gap: 6 },
  iconImage: { width: 56, height: 56, borderRadius: 13, borderWidth: 2.5 },
  iconLabel: { fontSize: 12 },
  content: { paddingBottom: 40 },
  firstGroup: { marginTop: 16 },
  lastInGroup: { paddingBottom: 12 },
  subhead: { fontSize: 13, paddingHorizontal: 16, paddingTop: 12 },
  input: { marginHorizontal: 16, marginBottom: 8, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, paddingHorizontal: 12, height: 44, fontSize: 15 },
  segment: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 8 },
  segmentItem: { flex: 1, textAlign: 'center', paddingVertical: 10, borderRadius: 10, overflow: 'hidden', fontWeight: '600' },
  stepper: { flexDirection: 'row' },
});
