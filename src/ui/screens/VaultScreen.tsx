import * as LocalAuthentication from 'expo-local-authentication';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ShieldEngine } from '../../../native/shield-webview';
import { useLibrary, type DownloadRecord } from '../../browser/library';
import { displayUrl } from '../../browser/url';
import { Icon, IconButton, Row, ScreenHeader, SectionTitle } from '../components/primitives';
import type { Theme } from '../theme';

type Props = { theme: Theme; onBack: () => void; onOpen: (url: string) => void };

type LockState = 'checking' | 'locked' | 'open' | 'noPasscode';

/** Private vault (Stillweb Plus): bookmarks and downloads from private tabs, behind Face ID or the passcode. */
export default function VaultScreen({ theme, onBack, onOpen }: Props) {
  const { vaultBookmarks, vaultDownloads, removeBookmark, removeDownload } = useLibrary();
  const [lock, setLock] = useState<LockState>('checking');

  /** Asks for Face ID / Touch ID / the passcode (the screen starts in 'checking'). */
  const authenticate = useCallback(async () => {
    try {
      // Without a passcode there is nothing to lock the vault with.
      if ((await LocalAuthentication.getEnrolledLevelAsync()) === LocalAuthentication.SecurityLevel.NONE) {
        setLock('noPasscode');
        return;
      }
      const result = await LocalAuthentication.authenticateAsync({ promptMessage: 'Open your private vault' });
      setLock(result.success ? 'open' : 'locked');
    } catch {
      setLock('locked');
    }
  }, []);

  const unlock = () => {
    setLock('checking');
    authenticate();
  };

  useEffect(() => {
    // Asks right away; its state changes all come after the system prompt (after an await).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    authenticate();
    // Locked again whenever the app leaves the screen.
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') setLock('locked');
    });
    return () => sub.remove();
  }, [authenticate]);

  const deleteDownload = (item: DownloadRecord) =>
    Alert.alert('Delete this file?', item.fileName, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          if (Platform.OS === 'ios' && item.filePath) ShieldEngine.deleteFile(item.filePath).catch(() => {});
          removeDownload(item.id);
        },
      },
    ]);

  const openDownload = (item: DownloadRecord) => {
    if (!item.filePath) return;
    ShieldEngine.openFile(item.filePath)
      .then((ok) => !ok && Alert.alert('File not found', 'It may still be downloading, or it was deleted.'))
      .catch(() => Alert.alert('Couldn’t open this file'));
  };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: theme.background }]} edges={['top', 'bottom', 'left', 'right']}>
      <ScreenHeader title="Private vault" onBack={onBack} theme={theme} />
      {lock === 'open' ? (
        <ScrollView contentContainerStyle={styles.content}>
          <SectionTitle theme={theme}>Bookmarks</SectionTitle>
          {vaultBookmarks.length ? (
            vaultBookmarks.map((b) => (
              <Row
                key={b.id}
                title={b.title}
                subtitle={displayUrl(b.url)}
                icon="star"
                theme={theme}
                onPress={() => onOpen(b.url)}
                right={<IconButton name="trash-2" label="Delete bookmark" color={theme.muted} size={18} onPress={() => removeBookmark(b.id)} />}
              />
            ))
          ) : (
            <Text style={[styles.empty, { color: theme.muted }]}>Bookmarks you add in a private tab are kept here.</Text>
          )}
          {Platform.OS === 'ios' ? (
            <>
              <SectionTitle theme={theme}>Downloads</SectionTitle>
              {vaultDownloads.length ? (
                vaultDownloads.map((d) => (
                  <Row
                    key={d.id}
                    title={d.fileName}
                    subtitle={displayUrl(d.url).split('/')[0]}
                    icon="file"
                    theme={theme}
                    onPress={() => openDownload(d)}
                    right={<IconButton name="trash-2" label="Delete file" color={theme.muted} size={18} onPress={() => deleteDownload(d)} />}
                  />
                ))
              ) : (
                <Text style={[styles.empty, { color: theme.muted }]}>
                  Files you download in a private tab are kept here, out of the Files app.
                </Text>
              )}
            </>
          ) : null}
        </ScrollView>
      ) : lock === 'checking' ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.muted} />
        </View>
      ) : (
        <View style={styles.center}>
          <View style={[styles.badge, { backgroundColor: theme.surface }]}>
            <Icon name="lock" size={32} color={theme.muted} />
          </View>
          <Text style={[styles.title, { color: theme.text }]}>
            {lock === 'noPasscode' ? 'Set a passcode first' : 'Your vault is locked'}
          </Text>
          <Text style={[styles.body, { color: theme.muted }]}>
            {lock === 'noPasscode'
              ? 'The vault opens with Face ID, Touch ID or your passcode. Set a passcode in Settings to use it.'
              : 'Unlock with Face ID, Touch ID or your passcode.'}
          </Text>
          {lock === 'locked' ? (
            <Pressable onPress={unlock} style={[styles.button, { backgroundColor: theme.accent }]} accessibilityRole="button">
              <Text style={styles.buttonText}>Unlock</Text>
            </Pressable>
          ) : null}
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingBottom: 40 },
  empty: { fontSize: 14, lineHeight: 20, paddingHorizontal: 16, paddingVertical: 8 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
  badge: { width: 72, height: 72, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 20, fontWeight: '700', textAlign: 'center' },
  body: { fontSize: 15, lineHeight: 21, textAlign: 'center' },
  button: { marginTop: 8, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 24 },
  buttonText: { color: '#FFFFFF', fontWeight: '600', fontSize: 15 },
});
