import { useRef, useState } from 'react';
import { FlatList, Image, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { DEFAULT_PROFILE_NAME, profileOf, type Profile } from '../../browser/profiles';
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
  /** Opens a new tab with the address bar ready for typing (in a profile when one is shown). */
  onNewTab: (asPrivate: boolean, profileId?: string | null) => void;
  /** Stillweb Plus profiles (empty without Plus): normal tabs are shown one profile at a time. */
  profiles: Profile[];
};

const GAP = 12;
const PADDING = 12;

export default function TabSwitcherScreen(props: Props) {
  const { theme, initialPrivate, privateLocked, onUnlock, onClose, onPrivateClosed, onNewTab, profiles } = props;
  const { tabs, activeTab, activate, closeTab, closeAll, closeTabs } = useTabs();
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  // The usable area, inside the system bars and display cut-outs.
  const width = window.width - insets.left - insets.right;
  const height = window.height - insets.top - insets.bottom;
  // Two tabs side by side on phones; wider screens (landscape, tablets) fit more.
  const columns = width >= 900 ? 4 : width >= 600 ? 3 : 2;
  const [showPrivate, setShowPrivate] = useState(initialPrivate);
  const byProfile = profiles.length > 0;
  // Starts on the profile of the tab in use (or used last).
  const [viewProfile, setViewProfile] = useState<string | null>(() => {
    const normal =
      activeTab && !activeTab.incognito
        ? activeTab
        : tabs.filter((t) => !t.incognito).sort((a, b) => b.lastActive - a.lastActive)[0];
    return normal ? profileOf(normal, profiles) : null;
  });
  const inView = (t: Tab) => t.incognito === showPrivate && (showPrivate || !byProfile || profileOf(t, profiles) === viewProfile);
  const list = tabs.filter(inView);
  const locked = showPrivate && privateLocked;
  const bg = showPrivate ? theme.privateBackground : theme.background;
  const card = showPrivate ? theme.privateSurface : theme.surface;
  const fg = showPrivate ? '#ECE6F7' : theme.text;
  const muted = showPrivate ? '#B3A8CC' : theme.muted;
  const accent = showPrivate ? '#8B6FE0' : theme.accent;

  const cardWidth = (width - PADDING * 2 - GAP * (columns - 1)) / columns;
  // Thumbnails keep roughly the shape of the page area so snapshots aren't distorted.
  const thumbHeight = Math.min(cardWidth * (height / width) * 0.62, cardWidth * 1.45);

  // Opens with the tab in use in the middle of the screen, not at the top of the list.
  const rowHeight = 44 + thumbHeight;
  const grid = useRef<FlatList<Tab>>(null);
  const gridHeight = useRef(0);
  // Once per list shown (not again when a tab is closed and the list gets shorter).
  const gridKey = `grid-${columns}-${showPrivate}-${viewProfile ?? ''}`;
  const placedFor = useRef('');
  const showActive = (last: boolean) => {
    const viewHeight = gridHeight.current;
    if (placedFor.current === gridKey) return;
    if (last) placedFor.current = gridKey;
    const index = list.findIndex((t) => t.id === activeTab?.id);
    if (index < 0 || !viewHeight) return;
    const rows = Math.ceil(list.length / columns);
    const top = PADDING + Math.floor(index / columns) * (rowHeight + GAP);
    const end = PADDING * 2 + rows * rowHeight + (rows - 1) * GAP - viewHeight;
    const offset = Math.max(0, Math.min(top - (viewHeight - rowHeight) / 2, end));
    if (offset > 0) grid.current?.scrollToOffset({ offset, animated: false });
  };

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

      {byProfile && !showPrivate ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.profilesBar} contentContainerStyle={styles.profiles}>
          {[{ id: null as string | null, name: DEFAULT_PROFILE_NAME }, ...profiles].map((p) => {
            const selected = viewProfile === p.id;
            const count = tabs.filter((t) => !t.incognito && profileOf(t, profiles) === p.id).length;
            return (
              <Pressable
                key={p.id ?? 'default'}
                onPress={() => setViewProfile(p.id)}
                accessibilityRole="tab"
                accessibilityState={{ selected }}
                accessibilityLabel={`${p.name} profile, ${count} ${count === 1 ? 'tab' : 'tabs'}`}
                style={[styles.profileChip, { backgroundColor: selected ? theme.accent : card }]}>
                <Icon name="user" size={14} color={selected ? '#FFFFFF' : muted} />
                <Text style={[styles.profileText, { color: selected ? '#FFFFFF' : fg }]} numberOfLines={1}>
                  {p.name}
                </Text>
                <Text style={[styles.profileCount, { color: selected ? '#FFFFFF' : muted }]}>{count}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}

      {locked ? (
        <Pressable style={styles.locked} onPress={onUnlock}>
          <Icon name="lock" size={36} color={fg} />
          <Text style={[styles.lockedText, { color: fg }]}>Private tabs are locked</Text>
          <Text style={{ color: muted }}>Tap to unlock</Text>
        </Pressable>
      ) : (
        <FlatList
          key={gridKey}
          data={list}
          keyExtractor={(t) => t.id}
          numColumns={columns}
          ref={grid}
          getItemLayout={(_, index) => ({ length: rowHeight, offset: PADDING + (rowHeight + GAP) * index, index })}
          onLayout={(e) => {
            gridHeight.current = e.nativeEvent.layout.height;
            showActive(false);
            // And once more when the cards have been measured (while the screen still fades
            // in): before that the list can't scroll all the way to its last row.
            setTimeout(() => showActive(true), 90);
          }}
          onContentSizeChange={() => showActive(false)}
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
            if (showPrivate) {
              closeAll(true);
              onPrivateClosed();
              setShowPrivate(false);
            } else {
              // Only the profile on screen.
              closeTabs(list.map((t) => t.id));
            }
          }}
          hitSlop={8}>
          <Text style={{ color: list.length && !locked ? theme.danger : muted, fontSize: 15 }}>Close all</Text>
        </Pressable>
        <Pressable
          style={[styles.newTab, { backgroundColor: showPrivate ? '#5B3FA0' : theme.accent }]}
          onPress={() => onNewTab(showPrivate, byProfile && !showPrivate ? viewProfile : undefined)}
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
  profilesBar: { flexGrow: 0 },
  profiles: { paddingHorizontal: 12, paddingBottom: 4, gap: 8 },
  profileChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, height: 34, borderRadius: 17, maxWidth: 200 },
  profileText: { fontSize: 14, fontWeight: '600', flexShrink: 1 },
  profileCount: { fontSize: 13, fontWeight: '600' },
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
