import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ScreenHeader } from '../components/primitives';
import type { Theme } from '../theme';

type Part = { text: string; bold?: boolean; italic?: boolean; href?: string };
type Block = { type: 'title' | 'meta' | 'summary' | 'heading' | 'paragraph' | 'item'; parts: Part[] };

/** From site/privacy/index.html (npm run build:privacy): the app shows the same words as the website. */
const POLICY: Block[] = require('../privacy.generated.json');

/**
 * The privacy policy as a page of the app, so it never opens the policy's web address. Email
 * addresses open the mail app; other links open in a tab (`onOpen`).
 */
export default function PrivacyPolicyScreen({
  theme,
  onBack,
  onOpen,
}: {
  theme: Theme;
  onBack: () => void;
  onOpen: (url: string) => void;
}) {
  const runs = (parts: Part[]) =>
    parts.map((p, i) => (
      <Text
        key={i}
        style={[p.bold && styles.bold, p.italic && styles.italic, p.href ? { color: theme.accent } : null]}
        onPress={
          p.href
            ? () => (p.href!.startsWith('mailto:') ? Linking.openURL(p.href!).catch(() => {}) : onOpen(p.href!))
            : undefined
        }>
        {p.text}
      </Text>
    ));

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: theme.background }]} edges={['top', 'bottom', 'left', 'right']}>
      <ScreenHeader title="Privacy policy" onBack={onBack} theme={theme} />
      <ScrollView contentContainerStyle={styles.content}>
        {POLICY.map((block, i) => {
          switch (block.type) {
            case 'title':
              // The screen's header already names it.
              return null;
            case 'meta':
              return (
                <Text key={i} style={[styles.meta, { color: theme.muted }]}>
                  {runs(block.parts)}
                </Text>
              );
            case 'summary':
              return (
                <View key={i} style={[styles.summary, { backgroundColor: theme.surface }]}>
                  <Text style={[styles.body, { color: theme.text }]}>{runs(block.parts)}</Text>
                </View>
              );
            case 'heading':
              return (
                <Text key={i} style={[styles.heading, { color: theme.text }]} accessibilityRole="header">
                  {runs(block.parts)}
                </Text>
              );
            case 'item':
              return (
                <View key={i} style={styles.item}>
                  <Text style={[styles.body, { color: theme.accent }]}>•</Text>
                  <Text style={[styles.body, styles.itemText, { color: theme.text }]}>{runs(block.parts)}</Text>
                </View>
              );
            default:
              return (
                <Text key={i} style={[styles.body, styles.paragraph, { color: theme.text }]}>
                  {runs(block.parts)}
                </Text>
              );
          }
        })}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 40 },
  meta: { fontSize: 13, marginBottom: 12 },
  summary: { borderRadius: 16, padding: 16, marginBottom: 8 },
  heading: { fontSize: 18, fontWeight: '700', marginTop: 22, marginBottom: 8 },
  body: { fontSize: 15, lineHeight: 22 },
  paragraph: { marginBottom: 10 },
  item: { flexDirection: 'row', gap: 10, marginBottom: 8 },
  itemText: { flex: 1 },
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },
});
