import { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { ShieldEngine } from '../../../native/shield-webview';
import { DEFAULT_PROFILE_NAME, MAX_PROFILE_NAME, MAX_PROFILES, newProfileId, profileOf, type Profile } from '../../browser/profiles';
import { useSettings } from '../../browser/settings';
import { useTabs } from '../../browser/tabs';
import type { Theme } from '../theme';
import { IconButton, Row, SectionTitle } from './primitives';

/** Web views of closed tabs are gone by then, so their profile's data store can be deleted. */
const DELETE_DELAY_MS = 1500;

type Props = { theme: Theme; unlocked: boolean; onOpenPlus: () => void };

/**
 * Stillweb Plus profiles in Settings. Adding and renaming need Plus; deleting always works,
 * so profiles made before Plus ended can still be removed with their data.
 */
export default function ProfilesSection({ theme, unlocked, onOpenPlus }: Props) {
  const { settings, update } = useSettings();
  const { tabs, closeTabs, openTab } = useTabs();
  // The profile being named: an existing id, 'new', or none.
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');

  if (ShieldEngine.profilesSupported !== true) return null;
  const profiles = settings.profiles;

  const countLabel = (id: string | null) => {
    const n = tabs.filter((t) => !t.incognito && profileOf(t, profiles) === id).length;
    return `${n} open ${n === 1 ? 'tab' : 'tabs'}`;
  };

  const startEditing = (id: string, current: string) => {
    if (!unlocked) return onOpenPlus();
    setEditing(id);
    setName(current);
  };

  const save = () => {
    const trimmed = name.trim().slice(0, MAX_PROFILE_NAME);
    if (trimmed && editing === 'new') update({ profiles: [...profiles, { id: newProfileId(), name: trimmed }] });
    else if (trimmed) update({ profiles: profiles.map((p) => (p.id === editing ? { ...p, name: trimmed } : p)) });
    setEditing(null);
  };

  const remove = (profile: Profile) =>
    Alert.alert(`Delete “${profile.name}”?`, 'Closes its tabs and deletes its cookies, logins and site data. Bookmarks and history stay.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          const ids = tabs.filter((t) => !t.incognito && t.profileId === profile.id).map((t) => t.id);
          closeTabs(ids);
          // Always leave a normal tab to come back to.
          if (ids.length && !tabs.some((t) => !t.incognito && !ids.includes(t.id))) openTab('', { profileId: null });
          update({ profiles: profiles.filter((p) => p.id !== profile.id) });
          if (editing === profile.id) setEditing(null);
          setTimeout(() => ShieldEngine.deleteProfileData(profile.id).catch(() => {}), DELETE_DELAY_MS);
        },
      },
    ]);

  const editor = (
    <View style={[styles.editor, { backgroundColor: theme.surface }]}>
      <TextInput
        value={name}
        onChangeText={setName}
        autoFocus
        maxLength={MAX_PROFILE_NAME}
        placeholder="Profile name, like Work"
        placeholderTextColor={theme.muted}
        returnKeyType="done"
        onSubmitEditing={save}
        style={[styles.input, { color: theme.text }]}
        accessibilityLabel="Profile name"
      />
      <Pressable onPress={() => setEditing(null)} hitSlop={8} accessibilityRole="button">
        <Text style={[styles.action, { color: theme.muted }]}>Cancel</Text>
      </Pressable>
      <Pressable onPress={save} hitSlop={8} accessibilityRole="button" disabled={!name.trim()}>
        <Text style={[styles.action, { color: name.trim() ? theme.accent : theme.muted }]}>Save</Text>
      </Pressable>
    </View>
  );

  return (
    <>
      <SectionTitle theme={theme}>{unlocked ? 'Profiles' : 'Profiles · Plus'}</SectionTitle>
      <Text style={[styles.note, { color: theme.muted }]}>
        Keep work and personal browsing apart. Each profile has its own tabs, logins, cookies and site data. Tap a profile to rename it.
      </Text>
      <Row title={DEFAULT_PROFILE_NAME} subtitle={`Default · ${countLabel(null)}`} icon="user" theme={theme} />
      {profiles.map((p) =>
        editing === p.id ? (
          <View key={p.id}>{editor}</View>
        ) : (
          <Row
            key={p.id}
            title={p.name}
            subtitle={countLabel(p.id)}
            icon="user"
            theme={theme}
            onPress={() => startEditing(p.id, p.name)}
            right={<IconButton name="trash-2" label={`Delete ${p.name}`} color={theme.muted} size={18} onPress={() => remove(p)} />}
          />
        ),
      )}
      {editing === 'new' ? (
        editor
      ) : profiles.length < MAX_PROFILES ? (
        <Row title="Add a profile" icon="plus" theme={theme} onPress={() => startEditing('new', '')} />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  note: { fontSize: 13, lineHeight: 18, paddingHorizontal: 16, paddingBottom: 6 },
  editor: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginHorizontal: 12,
    marginVertical: 4,
    paddingHorizontal: 14,
    borderRadius: 12,
    minHeight: 50,
  },
  input: { flex: 1, fontSize: 16, paddingVertical: 10 },
  action: { fontSize: 15, fontWeight: '600' },
});
