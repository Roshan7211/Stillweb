import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { Theme } from '../theme';
import { Icon, Row, Sheet, type IconName } from './primitives';

export type MenuAction =
  | 'newTab'
  | 'newPrivateTab'
  | 'bookmarks'
  | 'history'
  | 'downloads'
  | 'settings'
  | 'toggleBookmark'
  | 'reader'
  | 'find'
  | 'share'
  | 'listen'
  | 'desktop'
  | 'hideElement'
  | 'layoutInfo'
  | 'vault'
  | 'quit'
  | 'back'
  | 'forward';

type Props = {
  visible: boolean;
  onClose: () => void;
  theme: Theme;
  hasPage: boolean;
  bookmarked: boolean;
  readerActive: boolean;
  /** The current site is shown as its desktop website. */
  desktop: boolean;
  showQuit: boolean;
  clearsOnQuit: boolean;
  /** Single bottom bar: forward (and back, for the long reach) live in the menu. */
  navigation?: { canGoBack: boolean; canGoForward: boolean };
  /** Test builds: a row that shows the page's sizes and zoom, for reporting layout problems. */
  showLayoutInfo?: boolean;
  onAction: (action: MenuAction) => void;
};

export default function MenuSheet({
  visible,
  onClose,
  theme,
  hasPage,
  bookmarked,
  readerActive,
  desktop,
  showQuit,
  clearsOnQuit,
  navigation,
  showLayoutInfo,
  onAction,
}: Props) {
  const quick: { action: MenuAction; icon: IconName; label: string; active?: boolean }[] = [
    { action: 'toggleBookmark', icon: 'star', label: bookmarked ? 'Saved' : 'Bookmark', active: bookmarked },
    { action: 'reader', icon: 'book-open', label: readerActive ? 'Exit reader' : 'Reader', active: readerActive },
    { action: 'listen', icon: 'headphones', label: 'Listen' },
    { action: 'find', icon: 'search', label: 'Find' },
    { action: 'share', icon: 'share-2', label: 'Share' },
  ];

  return (
    <Sheet visible={visible} onClose={onClose} theme={theme}>
      <View style={styles.quick}>
        {quick.map((q) => {
          const color = q.active ? theme.accent : theme.text;
          return (
            <Pressable
              key={q.action}
              disabled={!hasPage}
              onPress={() => onAction(q.action)}
              accessibilityRole="button"
              accessibilityLabel={q.label}
              style={({ pressed }) => [
                styles.quickButton,
                { backgroundColor: theme.background, opacity: !hasPage ? 0.35 : pressed ? 0.6 : 1 },
              ]}>
              <Icon name={q.icon} size={22} color={color} />
              <Text style={[styles.quickLabel, { color }]} numberOfLines={1}>
                {q.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <ScrollView>
        {navigation && hasPage ? (
          <View style={styles.nav}>
            {(['back', 'forward'] as const).map((direction) => {
              const enabled = direction === 'back' ? navigation.canGoBack : navigation.canGoForward;
              return (
                <Pressable
                  key={direction}
                  disabled={!enabled}
                  onPress={() => onAction(direction)}
                  accessibilityRole="button"
                  accessibilityLabel={direction === 'back' ? 'Back' : 'Forward'}
                  style={({ pressed }) => [
                    styles.navButton,
                    { backgroundColor: theme.background, opacity: !enabled ? 0.35 : pressed ? 0.6 : 1 },
                  ]}>
                  <Icon name={direction === 'back' ? 'chevron-left' : 'chevron-right'} size={22} color={theme.text} />
                  <Text style={[styles.navLabel, { color: theme.text }]}>{direction === 'back' ? 'Back' : 'Forward'}</Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}
        {hasPage ? (
          <>
            <Row
              title={desktop ? 'Mobile website' : 'Desktop website'}
              icon={desktop ? 'smartphone' : 'monitor'}
              theme={theme}
              onPress={() => onAction('desktop')}
            />
            <Row title="Hide an element" icon="crosshair" theme={theme} onPress={() => onAction('hideElement')} />
            {showLayoutInfo ? (
              <Row
                title="Page layout info"
                subtitle="Test builds only: sizes and zoom, to send with a report"
                icon="info"
                theme={theme}
                onPress={() => onAction('layoutInfo')}
              />
            ) : null}
          </>
        ) : null}
        <Row title="New tab" icon="plus" theme={theme} onPress={() => onAction('newTab')} />
        <Row title="New private tab" icon="eye-off" theme={theme} onPress={() => onAction('newPrivateTab')} />
        <Row title="Bookmarks" icon="bookmark" theme={theme} onPress={() => onAction('bookmarks')} />
        <Row title="History" icon="clock" theme={theme} onPress={() => onAction('history')} />
        <Row title="Downloads" icon="download" theme={theme} onPress={() => onAction('downloads')} />
        <Row title="Private vault" icon="lock" theme={theme} onPress={() => onAction('vault')} />
        <Row title="Settings" icon="settings" theme={theme} onPress={() => onAction('settings')} />
        {showQuit ? (
          <Row
            title={clearsOnQuit ? 'Quit and clear data' : 'Quit'}
            icon="power"
            theme={theme}
            danger={clearsOnQuit}
            onPress={() => onAction('quit')}
          />
        ) : null}
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  quick: { flexDirection: 'row', justifyContent: 'center', gap: 8, paddingHorizontal: 12, paddingBottom: 8 },
  quickButton: { flex: 1, maxWidth: 76, height: 66, borderRadius: 14, alignItems: 'center', justifyContent: 'center', gap: 4 },
  quickLabel: { fontSize: 11, fontWeight: '500' },
  nav: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingBottom: 8 },
  navButton: { flex: 1, height: 44, borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 },
  navLabel: { fontSize: 15, fontWeight: '500' },
});
