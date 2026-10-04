import Constants from 'expo-constants';
import { Image, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PRIVACY_POLICY_URL } from '../../blocking/config';
import catalog from '../../blocking/filter-catalog.json';
import { READABILITY_VERSION } from '../../browser/readability.generated';
import { Row, ScreenHeader, SectionTitle } from '../components/primitives';
import type { Theme } from '../theme';

type Props = { theme: Theme; onBack: () => void; onOpen: (url: string) => void };

const LOGO = require('../../../assets/logo.png');

const SOFTWARE = [
  ...catalog.software,
  { title: `Readability ${READABILITY_VERSION} (reader view)`, homepage: 'https://github.com/mozilla/readability', license: 'Apache-2.0' },
  { title: 'React Native', homepage: 'https://reactnative.dev', license: 'MIT' },
  { title: 'Expo', homepage: 'https://expo.dev', license: 'MIT' },
  { title: 'Feather icons', homepage: 'https://feathericons.com', license: 'MIT' },
];

export default function AboutScreen({ theme, onBack, onOpen }: Props) {
  const lists = catalog.lists.filter((l) => !('platforms' in l) || (l.platforms as string[]).includes(Platform.OS));
  return (
    <SafeAreaView style={[styles.root, { backgroundColor: theme.background }]} edges={['top', 'bottom', 'left', 'right']}>
      <ScreenHeader title="About" onBack={onBack} theme={theme} />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.hero}>
          <Image source={LOGO} style={styles.logo} accessible={false} />
          <Text style={[styles.name, { color: theme.text }]}>{Constants.expoConfig?.name ?? 'Browser'}</Text>
          <Text style={{ color: theme.muted }}>Version {Constants.expoConfig?.version ?? '—'}</Text>
          <Text style={[styles.body, { color: theme.muted }]}>
            A calm, private browser that blocks ads and trackers on your device.
          </Text>
        </View>

        <SectionTitle theme={theme}>Your privacy</SectionTitle>
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
        {PRIVACY_POLICY_URL ? (
          <Row title="Privacy policy" icon="external-link" theme={theme} onPress={() => onOpen(PRIVACY_POLICY_URL as string)} />
        ) : null}

        <SectionTitle theme={theme}>Filter lists</SectionTitle>
        <Text style={[styles.body, styles.pad, { color: theme.muted }]}>
          Ad and tracker blocking uses these community-maintained lists, used under their licenses. Thank you to
          their authors.
        </Text>
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
          subtitle={`Used for pop-up and inline ad defusing · License: ${catalog.resources.license}`}
          theme={theme}
          icon="external-link"
          onPress={() => onOpen(catalog.resources.licenseUrl)}
        />

        <SectionTitle theme={theme}>Open-source software</SectionTitle>
        {SOFTWARE.map((s) => (
          <Row key={s.title} title={s.title} subtitle={`License: ${s.license}`} theme={theme} icon="external-link" onPress={() => onOpen(s.homepage)} />
        ))}

        <Text style={[styles.body, styles.pad, { color: theme.muted, marginTop: 16 }]}>
          GPLv3, CC BY-SA 3.0 and CC BY 3.0 licensed filter data is distributed unmodified apart from automated format
          conversion; the source of every list is linked above.
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
  pad: { paddingHorizontal: 16, textAlign: 'left' },
  bullet: { flexDirection: 'row', gap: 10, paddingHorizontal: 16, paddingVertical: 4 },
  bulletText: { flex: 1, fontSize: 15, lineHeight: 21 },
});
