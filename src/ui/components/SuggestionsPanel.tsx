import { Keyboard, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { RemoteSuggestion } from '../../browser/suggest';
import { displayUrl, hostOf, looksLikeUrl } from '../../browser/url';
import type { Theme } from '../theme';
import { Icon, IconButton, type IconName } from './primitives';

export type SiteSuggestion = { url: string; title: string; kind: 'bookmark' | 'history' };

type Props = {
  theme: Theme;
  incognito: boolean;
  /** Trimmed text being typed ('' while the field still shows the page address). */
  query: string;
  sites: SiteSuggestion[];
  remote: RemoteSuggestion[];
  /** Name of the search engine the remote suggestions come from. */
  engineLabel: string;
  /** Space covered at the bottom (keyboard and a bottom address bar). */
  bottomInset: number;
  /** Space covered at the top (the status bar, edge-to-edge layout). */
  topInset?: number;
  onOpen: (url: string) => void;
  onSearch: (text: string) => void;
  /** Puts a suggestion into the address field to keep typing. */
  onFill: (text: string) => void;
};

const MAX_SITES = 4;

/** One key per site: www. and mobile m. versions are the same site. */
const siteOf = (url: string) => hostOf(url).replace(/^(www|m|mobile)\./, '');
const MAX_SEARCHES = 8;

/** Shows the typed prefix plain and the completion bold, like Safari. */
function Completion({ text, query, color }: { text: string; query: string; color: string }) {
  const typed = text.toLowerCase().startsWith(query.toLowerCase()) ? text.slice(0, query.length) : '';
  return (
    <Text style={[styles.title, { color }]} numberOfLines={1}>
      {typed}
      <Text style={styles.bold}>{text.slice(typed.length)}</Text>
    </Text>
  );
}

/** Covers the page while the address is being edited: suggestions, or a dimmed page to tap away. */
export default function SuggestionsPanel(props: Props) {
  const { theme, incognito, query, sites, remote, engineLabel, bottomInset, topInset = 0 } = props;
  const fg = incognito ? '#ECE6F7' : theme.text;
  const muted = incognito ? '#B3A8CC' : theme.muted;
  const bg = incognito ? theme.privateBackground : theme.background;
  const highlight = incognito ? theme.privateSurface : theme.accentSoft;

  if (!query) {
    return (
      <Pressable
        style={[StyleSheet.absoluteFill, styles.dim]}
        onPress={() => Keyboard.dismiss()}
        accessibilityRole="button"
        accessibilityLabel="Stop editing the address"
      />
    );
  }

  // Sites the engine recognises ("youtube.com" for "you") join the ones from history.
  const seenSites = new Set(sites.map((s) => siteOf(s.url)));
  const remoteSites = remote.flatMap((r) => {
    if (r.kind !== 'site') return [];
    const site = siteOf(r.url);
    if (seenSites.has(site)) return [];
    seenSites.add(site);
    return [{ url: r.url, title: r.title || site }];
  });
  const siteRows: { url: string; title: string; icon: IconName }[] = [
    ...sites.map((s) => ({ url: s.url, title: s.title, icon: (s.kind === 'bookmark' ? 'star' : 'clock') as IconName })),
    ...remoteSites.map((s) => ({ ...s, icon: 'globe' as IconName })),
  ].slice(0, MAX_SITES);
  const lowerQuery = query.toLowerCase();
  const searches = remote
    .flatMap((r) => (r.kind === 'search' && r.text.toLowerCase() !== lowerQuery ? [r.text] : []))
    .slice(0, MAX_SEARCHES);
  const isUrl = looksLikeUrl(query);

  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: bg }]}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingTop: topInset, paddingBottom: bottomInset + 12 }}>
        <Pressable
          style={({ pressed }) => [styles.row, { backgroundColor: pressed ? highlight : 'transparent' }]}
          onPress={() => (isUrl ? props.onOpen(query) : props.onSearch(query))}
          accessibilityRole="button">
          <Icon name={isUrl ? 'globe' : 'search'} size={18} color={muted} />
          <Text style={[styles.title, styles.bold, { color: fg }]} numberOfLines={1}>
            {isUrl ? `Go to ${query}` : query}
          </Text>
        </Pressable>

        {siteRows.length ? (
          <>
            <Text style={[styles.section, { color: muted }]}>Sites</Text>
            {siteRows.map((site, i) => (
              <Pressable
                key={site.url}
                style={({ pressed }) => [
                  styles.row,
                  { backgroundColor: pressed || (i === 0 && !isUrl) ? highlight : 'transparent' },
                  i === 0 && styles.topHit,
                ]}
                onPress={() => props.onOpen(site.url)}
                accessibilityRole="button"
                accessibilityLabel={`${site.title}, ${displayUrl(site.url)}`}>
                <Icon name={site.icon} size={18} color={i === 0 && !isUrl ? theme.accent : muted} />
                <View style={styles.text}>
                  <Text style={[styles.title, { color: fg }]} numberOfLines={1}>
                    {site.title || displayUrl(site.url)}
                  </Text>
                  <Text style={[styles.subtitle, { color: muted }]} numberOfLines={1}>
                    {displayUrl(site.url)}
                  </Text>
                </View>
              </Pressable>
            ))}
          </>
        ) : null}

        {searches.length ? (
          <>
            <Text style={[styles.section, { color: muted }]}>{engineLabel ? `${engineLabel} suggestions` : 'Suggestions'}</Text>
            {searches.map((text) => (
              <Pressable
                key={text}
                style={({ pressed }) => [styles.row, { backgroundColor: pressed ? highlight : 'transparent' }]}
                onPress={() => props.onSearch(text)}
                accessibilityRole="button"
                accessibilityLabel={`Search for ${text}`}>
                <Icon name="search" size={18} color={muted} />
                <View style={styles.text}>
                  <Completion text={text} query={query} color={fg} />
                </View>
                <IconButton name="arrow-up-left" label={`Edit ${text}`} size={18} color={muted} onPress={() => props.onFill(text)} />
              </Pressable>
            ))}
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  dim: { backgroundColor: 'rgba(0,0,0,0.3)' },
  section: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 4,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingLeft: 16, paddingRight: 6, minHeight: 48 },
  topHit: { marginHorizontal: 8, paddingLeft: 8, borderRadius: 12 },
  text: { flex: 1, paddingVertical: 8 },
  title: { fontSize: 16, flexShrink: 1 },
  subtitle: { fontSize: 13, marginTop: 1 },
  bold: { fontWeight: '600' },
});
