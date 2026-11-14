import Constants from 'expo-constants';
import { useEffect, useState } from 'react';
import { BackHandler, Image, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import catalog from '../../blocking/filter-catalog.json';
import { READABILITY_VERSION } from '../../browser/readability.generated';
import { Group, Icon, readable, Row, ScreenHeader, SectionTitle } from '../components/primitives';
import type { Theme } from '../theme';
import PrivacyPolicyScreen from './PrivacyPolicyScreen';

type Props = { theme: Theme; onBack: () => void; onOpen: (url: string) => void };

const LOGO = require('../../../assets/logo.png');

type Licenses = {
  components: { name: string; license: string; text: string }[];
  texts: Record<string, string>;
};

/** Loaded when opened: the notices are long and nothing else needs them. */
function loadLicenses(): Licenses {
  return require('../licenses.generated.json');
}

const SOFTWARE = [
  ...catalog.software,
  { title: `Readability ${READABILITY_VERSION} (reader view)`, homepage: 'https://github.com/mozilla/readability', license: 'Apache-2.0' },
  { title: 'React Native', homepage: 'https://reactnative.dev', license: 'MIT' },
  { title: 'Expo', homepage: 'https://expo.dev', license: 'MIT' },
  { title: 'Feather icons', homepage: 'https://feathericons.com', license: 'MIT' },
];

export default function AboutScreen({ theme, onBack, onOpen }: Props) {
  // About › Privacy policy, or About › Open-source licenses › one notice or license text.
  const [page, setPage] = useState<'about' | 'privacy' | 'licenses' | { title: string; text: string }>('about');

  // Android back steps out of these pages before it closes About.
  const inSubpage = page !== 'about';
  useEffect(() => {
    if (!inSubpage) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setPage((p) => (p === 'licenses' || p === 'privacy' ? 'about' : 'licenses'));
      return true;
    });
    return () => sub.remove();
  }, [inSubpage]);

  if (page === 'privacy') {
    return <PrivacyPolicyScreen theme={theme} onBack={() => setPage('about')} onOpen={onOpen} />;
  }

  if (page === 'licenses') {
    const { components, texts } = loadLicenses();
    return (
      <SafeAreaView style={[styles.root, { backgroundColor: theme.background }]} edges={['top', 'bottom', 'left', 'right']}>
        <ScreenHeader title="Open-source licenses" onBack={() => setPage('about')} theme={theme} />
        <ScrollView contentContainerStyle={[readable, styles.content]}>
          <Text style={[styles.body, styles.pad, { color: theme.muted, marginTop: 12 }]}>
            Stillweb includes the following software and data, used under their licenses.
          </Text>
          <SectionTitle theme={theme}>Components</SectionTitle>
          <Group theme={theme}>
            {components.map((c) => (
              <Row key={c.name} title={c.name} subtitle={c.license} theme={theme} onPress={() => setPage({ title: c.name, text: c.text })} />
            ))}
          </Group>
          <SectionTitle theme={theme}>License texts</SectionTitle>
          <Group theme={theme}>
            {Object.entries(texts).map(([id, text]) => (
              <Row key={id} title={id} theme={theme} onPress={() => setPage({ title: id, text })} />
            ))}
          </Group>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (page !== 'about') {
    return (
      <SafeAreaView style={[styles.root, { backgroundColor: theme.background }]} edges={['top', 'bottom', 'left', 'right']}>
        <ScreenHeader title={page.title} onBack={() => setPage('licenses')} theme={theme} />
        <ScrollView contentContainerStyle={styles.licenseText}>
          <Text selectable style={[styles.mono, { color: theme.text }]}>
            {page.text}
          </Text>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // On iOS, lists marked iosHosts are used for their server rules (see scripts/filters/build.mjs).
  const lists = catalog.lists.filter(
    (l) => !('platforms' in l) || (l.platforms as string[]).includes(Platform.OS) || (Platform.OS === 'ios' && 'iosHosts' in l && l.iosHosts),
  );
  return (
    <SafeAreaView style={[styles.root, { backgroundColor: theme.background }]} edges={['top', 'bottom', 'left', 'right']}>
      <ScreenHeader title="About" onBack={onBack} theme={theme} />
      <ScrollView contentContainerStyle={[readable, styles.content]}>
        <View style={styles.hero}>
          <Image source={LOGO} style={styles.logo} accessible={false} />
          <Text style={[styles.name, { color: theme.text }]}>{Constants.expoConfig?.name ?? 'Browser'}</Text>
          <Text style={{ color: theme.muted }}>Version {Constants.expoConfig?.version ?? '—'}</Text>
          <Text style={[styles.body, { color: theme.muted }]}>
            A calm, private browser that blocks ads and trackers on your device.
          </Text>
        </View>

        <SectionTitle theme={theme}>Your privacy</SectionTitle>
        <Group theme={theme}>
        {[
          'No accounts, analytics, ads or tracking. Nothing about you is collected or sent to us.',
          'History, bookmarks and settings stay on this device. Clear them any time in Settings.',
          'Private tabs are never saved and their data is wiped when they close.',
          'Searches go only to the search engine you choose.',
          'Sites are told not to sell or share your data (Global Privacy Control).',
        ].map((line) => (
          <View key={line} style={styles.bullet}>
            <Text style={{ color: theme.accent }}>•</Text>
            <Text style={[styles.bulletText, { color: theme.text }]}>{line}</Text>
          </View>
        ))}
        <Row
          title="Privacy policy"
          icon="file-text"
          theme={theme}
          onPress={() => setPage('privacy')}
          right={<Icon name="chevron-right" size={20} color={theme.muted} />}
        />
        </Group>

        <SectionTitle theme={theme}>Blocking lists</SectionTitle>
        <Text style={[styles.body, styles.pad, { color: theme.muted }]}>
          Ad and tracker blocking uses these community-maintained lists, used under their licenses. Thank you to
          their authors.
        </Text>
        <Group theme={theme}>
        {lists.map((list) => (
          <Row
            key={list.id}
            title={list.title}
            subtitle={`${list.purpose} · License: ${list.license}`}
            theme={theme}
            icon="external-link"
            onPress={() => onOpen(list.licenseUrl)}
          />
        ))}
        <Row
          title={catalog.resources.title}
          subtitle={`Used to stop pop-ups and ads inside pages · License: ${catalog.resources.license}`}
          theme={theme}
          icon="external-link"
          onPress={() => onOpen(catalog.resources.licenseUrl)}
        />
        </Group>

        <SectionTitle theme={theme}>Open-source software</SectionTitle>
        <Group theme={theme}>
        {SOFTWARE.map((s) => (
          <Row key={s.title} title={s.title} subtitle={`License: ${s.license}`} theme={theme} icon="external-link" onPress={() => onOpen(s.homepage)} />
        ))}

        <Row
          title="Open-source licenses"
          subtitle="Full notices and license texts"
          theme={theme}
          onPress={() => setPage('licenses')}
          right={<Icon name="chevron-right" size={20} color={theme.muted} />}
        />
        </Group>

        <Text style={[styles.body, styles.pad, { color: theme.muted, marginTop: 16 }]}>
          The blocking lists are shared under the GPLv3, CC BY-SA 3.0 and CC BY 3.0 licenses. Stillweb only changes them
          into its own format; where each list comes from is linked above.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingBottom: 40 },
  hero: { alignItems: 'center', padding: 24, gap: 6 },
  logo: { width: 72, height: 72, borderRadius: 16, borderCurve: 'continuous', marginBottom: 6 },
  name: { fontSize: 24, fontWeight: '700' },
  body: { fontSize: 14, lineHeight: 20, textAlign: 'center' },
  pad: { paddingHorizontal: 28, paddingBottom: 8, textAlign: 'left' },
  bullet: { flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingVertical: 6 },
  bulletText: { flex: 1, fontSize: 15, lineHeight: 21 },
  licenseText: { padding: 16, paddingBottom: 40 },
  mono: { fontSize: 12, lineHeight: 17, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) },
});
