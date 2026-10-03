import { useState } from 'react';
import { FlatList, Image, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTabs, type Tab } from '../../browser/tabs';
import { displayHost, hostOf, isBlank } from '../../browser/url';
import { Icon, IconButton } from '../components/primitives';
import type { Theme } from '../theme';

type Props = {
  theme: Theme;
  initialPrivate: boolean;
  privateLocked: boolean;
  onUnlock: () => void;
  onClose: () => void;
  onPrivateClosed: () => void;
  /** Opens a new tab with the address bar ready for typing. */
  onNewTab: (asPrivate: boolean) => void;
};

const GAP = 12;
const PADDING = 12;

export default function TabSwitcherScreen({ theme, initialPrivate, privateLocked, onUnlock, onClose, onPrivateClosed, onNewTab }: Props) {
  const { tabs, activeTab, activate, closeTab, closeAll } = useTabs();
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  // The usable area, inside the system bars and display cut-outs.
  const width = window.width - insets.left - insets.right;
  const height = window.height - insets.top - insets.bottom;
  // Two tabs side by side on phones; wider screens (landscape, tablets) fit more.
  const columns = width >= 900 ? 4 : width >= 600 ? 3 : 2;
  const [showPrivate, setShowPrivate] = useState(initialPrivate);
  const list = tabs.filter((t) => t.incognito === showPrivate);
  const locked = showPrivate && privateLocked;
  const bg = showPrivate ? theme.privateBackground : theme.background;
  const card = showPrivate ? theme.privateSurface : theme.surface;
  const fg = showPrivate ? '#ECE6F7' : theme.text;
  const muted = showPrivate ? '#B3A8CC' : theme.muted;
  const accent = showPrivate ? '#8B6FE0' : theme.accent;

  const cardWidth = (width - PADDING * 2 - GAP * (columns - 1)) / columns;
  // Thumbnails keep roughly the shape of the page area so snapshots aren't distorted.
  const thumbHeight = Math.min(cardWidth * (height / width) * 0.62, cardWidth * 1.45);

  const close = (id: string) => {
    const remainingPrivate = tabs.filter((t) => t.incognito && t.id !== id).length;
    const wasPrivate = tabs.find((t) => t.id === id)?.incognito;
    closeTab(id);
    if (wasPrivate && remainingPrivate === 0) onPrivateClosed();
  };

  const renderTab = ({ item }: { item: Tab }) => {
    const selected = item.id === activeTab?.id;
    const blank = isBlank(item.url);
    const label = blank ? 'New tab' : item.title || displayHost(item.url);
    const letter = (hostOf(item.url).replace(/^www\./, '')[0] ?? '+').toUpperCase();
    return (
      <Pressable
        onPress={() => {
          activate(item.id);
          onClose();
        }}
        accessibilityRole="button"
        accessibilityLabel={`${label}${selected ? ', current tab' : ''}`}
        style={({ pressed }) => [
          styles.card,
          { width: cardWidth, backgroundColor: card, borderColor: selected ? accent : 'transparent', opacity: pressed ? 0.85 : 1 },
        ]}>
        <View style={styles.cardHeader}>
          <View style={[styles.favicon, { backgroundColor: accent }]}>
            <Text style={styles.faviconText}>{letter}</Text>
          </View>
          <Text style={[styles.cardTitle, { color: fg }]} numberOfLines={1}>
            {label}
          </Text>
          <IconButton name="x" label={`Close ${label}`} size={16} color={muted} onPress={() => close(item.id)} style={styles.closeButton} />
        </View>
        <View style={[styles.thumb, { height: thumbHeight, backgroundColor: bg }]}>
          {item.thumbnail && !blank ? (
            // Pinned to the top so the page header shows, like the page itself.
            <Image
              source={{ uri: item.thumbnail }}
              style={[styles.thumbImage, { aspectRatio: item.thumbAspect ?? 0.6 }]}
              resizeMode="cover"
            />
          ) : (
            <View style={styles.thumbPlaceholder}>
              <Icon name={blank ? 'plus' : item.incognito ? 'eye-off' : 'globe'} size={28} color={muted} />
              {!blank ? (
                <Text style={[styles.thumbHost, { color: muted }]} numberOfLines={1}>
                  {displayHost(item.url)}
                </Text>
              ) : null}
            </View>
          )}
        </View>
      </Pressable>
    );
  };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: bg }]} edges={['top', 'bottom', 'left', 'right']}>
      <View style={styles.header}>
        <View style={[styles.segment, { backgroundColor: card }]}>
          {[false, true].map((p) => (
            <Pressable
              key={String(p)}
              onPress={() => setShowPrivate(p)}
              accessibilityRole="tab"
              accessibilityState={{ selected: showPrivate === p }}
              style={[styles.segmentItem, showPrivate === p && { backgroundColor: p ? '#5B3FA0' : theme.accent }]}>
              <Text style={{ color: showPrivate === p ? '#FFFFFF' : muted, fontWeight: '600' }}>
                {p ? 'Private' : 'Tabs'} · {tabs.filter((t) => t.incognito === p).length}
              </Text>
            </Pressable>
          ))}
        </View>
        <IconButton name="x" label="Done" color={fg} onPress={onClose} />
      </View>

      {locked ? (
        <Pressable style={styles.locked} onPress={onUnlock}>
          <Icon name="lock" size={36} color={fg} />
          <Text style={[styles.lockedText, { color: fg }]}>Private tabs are locked</Text>
          <Text style={{ color: muted }}>Tap to unlock</Text>
        </Pressable>
      ) : (
        <FlatList
          key={`grid-${columns}`}
          data={list}
          keyExtractor={(t) => t.id}
          numColumns={columns}
          columnWrapperStyle={{ gap: GAP }}
          contentContainerStyle={styles.list}
          renderItem={renderTab}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Icon name={showPrivate ? 'eye-off' : 'layers'} size={32} color={muted} />
              <Text style={[styles.emptyText, { color: muted }]}>{showPrivate ? 'No private tabs' : 'No tabs'}</Text>
            </View>
          }
        />
      )}

      <View style={styles.footer}>
        <Pressable
          disabled={!list.length || locked}
          onPress={() => {
            closeAll(showPrivate);
            if (showPrivate) {
              onPrivateClosed();
              setShowPrivate(false);
            }
          }}
          hitSlop={8}>
          <Text style={{ color: list.length && !locked ? theme.danger : muted, fontSize: 15 }}>Close all</Text>
        </Pressable>
        <Pressable
          style={[styles.newTab, { backgroundColor: showPrivate ? '#5B3FA0' : theme.accent }]}
          onPress={() => onNewTab(showPrivate)}
          accessibilityLabel={showPrivate ? 'New private tab' : 'New tab'}>
          <Icon name="plus" size={24} color="#FFFFFF" />
        </Pressable>
        <View style={{ width: 70 }} />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, gap: 8 },
  segment: { flex: 1, flexDirection: 'row', borderRadius: 12, padding: 3 },
  segmentItem: { flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 10 },
  list: { padding: PADDING, gap: GAP, flexGrow: 1 },
  card: { borderRadius: 16, borderWidth: 2, overflow: 'hidden' },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 10, height: 40 },
  favicon: { width: 20, height: 20, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  faviconText: { color: '#FFFFFF', fontSize: 11, fontWeight: '700' },
  cardTitle: { flex: 1, fontSize: 13, fontWeight: '600' },
  closeButton: { width: 36, height: 40 },
  thumb: { overflow: 'hidden' },
  thumbImage: { position: 'absolute', top: 0, left: 0, width: '100%' },
  thumbPlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 8 },
  thumbHost: { fontSize: 12 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingTop: 80 },
  emptyText: { fontSize: 15 },
  locked: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  lockedText: { fontSize: 18, fontWeight: '600' },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 10 },
  newTab: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
});
