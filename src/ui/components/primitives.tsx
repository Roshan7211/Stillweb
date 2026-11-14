import Feather from '@expo/vector-icons/Feather';
import { useEffect, useState, type ComponentProps, type ReactNode } from 'react';
import { AccessibilityInfo, Animated, Dimensions, Easing, Modal, Pressable, StyleSheet, Switch, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Theme } from '../theme';

export type IconName = ComponentProps<typeof Feather>['name'];

export function Icon({ name, size = 22, color }: { name: IconName; size?: number; color: string }) {
  return <Feather name={name} size={size} color={color} />;
}

export function IconButton({
  name,
  onPress,
  color,
  disabled,
  label,
  size = 22,
  badge,
  style,
}: {
  name: IconName;
  onPress?: () => void;
  color: string;
  disabled?: boolean;
  label: string;
  size?: number;
  badge?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      style={({ pressed }) => [styles.iconButton, { opacity: disabled ? 0.35 : pressed ? 0.6 : 1 }, style]}>
      <Icon name={name} size={size} color={color} />
      {badge ? (
        <View style={[styles.badge, { borderColor: color }]}>
          <Text style={[styles.badgeText, { color }]}>{badge}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

/** The system's Reduce Motion setting: animations become plain fades or none. */
let reduceMotion = false;
AccessibilityInfo.isReduceMotionEnabled()
  .then((value) => {
    reduceMotion = value;
  })
  .catch(() => {});
AccessibilityInfo.addEventListener('reduceMotionChanged', (value) => {
  reduceMotion = value;
});

/** A screen that comes in with a short fade, settling into place (the tab switcher, Settings…). */
export function Appear({ style, children }: { style?: StyleProp<ViewStyle>; children: ReactNode }) {
  const [progress] = useState(() => new Animated.Value(reduceMotion ? 1 : 0));
  useEffect(() => {
    if (reduceMotion) return;
    Animated.timing(progress, { toValue: 1, duration: 180, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [progress]);
  const scale = progress.interpolate({ inputRange: [0, 1], outputRange: [1.04, 1] });
  return <Animated.View style={[style, { opacity: progress, transform: [{ scale }] }]}>{children}</Animated.View>;
}

export function Sheet({
  visible,
  onClose,
  theme,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  theme: Theme;
  children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  // Like the system's sheets: the backdrop fades in while the sheet slides up, and both go
  // the same way when it closes (the Modal stays until then). With Reduce Motion, a fade.
  const [mounted, setMounted] = useState(visible);
  if (visible && !mounted) setMounted(true);
  const [progress] = useState(() => new Animated.Value(0));
  const [height, setHeight] = useState(() => Dimensions.get('window').height);
  useEffect(() => {
    if (!mounted) return;
    progress.stopAnimation();
    const opening = visible;
    Animated.timing(progress, {
      toValue: opening ? 1 : 0,
      duration: opening ? 280 : 220,
      easing: opening ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished && !opening) setMounted(false);
    });
  }, [visible, mounted, progress]);
  const slide = reduceMotion ? 0 : height;
  return (
    <Modal visible={mounted} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <Animated.View style={[StyleSheet.absoluteFill, styles.backdrop, { opacity: progress }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close" />
      </Animated.View>
      <View style={styles.sheetHolder} pointerEvents="box-none">
        <Animated.View
          onLayout={(e) => setHeight(e.nativeEvent.layout.height)}
          style={[
            styles.sheet,
            { backgroundColor: theme.surface, paddingBottom: insets.bottom + 12 },
            reduceMotion
              ? { opacity: progress }
              : { transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [slide, 0] }) }] },
          ]}>
          <View style={[styles.grabber, { backgroundColor: theme.border }]} />
          {children}
        </Animated.View>
      </View>
    </Modal>
  );
}

export function ScreenHeader({
  title,
  onBack,
  theme,
  right,
}: {
  title: string;
  onBack: () => void;
  theme: Theme;
  right?: ReactNode;
}) {
  return (
    <View style={[styles.header, { borderColor: theme.border }]}>
      <IconButton name="arrow-left" label="Back" color={theme.text} onPress={onBack} />
      <Text style={[styles.headerTitle, { color: theme.text }]} numberOfLines={1}>
        {title}
      </Text>
      <View style={styles.headerRight}>{right}</View>
    </View>
  );
}

export function SectionTitle({ children, theme }: { children: ReactNode; theme: Theme }) {
  return <Text style={[styles.section, { color: theme.muted }]}>{children}</Text>;
}

/** A rounded box in the theme's surface color that holds one section's rows. */
export function Group({ theme, children, style }: { theme: Theme; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.group, { backgroundColor: theme.surface }, style]}>{children}</View>;
}

/**
 * One row's part of a box, for long lists that render row by row: the first and last rows of a
 * run get the rounded corners.
 */
export function groupItemStyle(theme: Theme, first: boolean, last: boolean): ViewStyle {
  const radius = 16;
  return {
    marginHorizontal: 16,
    backgroundColor: theme.surface,
    overflow: 'hidden',
    borderTopLeftRadius: first ? radius : 0,
    borderTopRightRadius: first ? radius : 0,
    borderBottomLeftRadius: last ? radius : 0,
    borderBottomRightRadius: last ? radius : 0,
    paddingTop: first ? 4 : 0,
    paddingBottom: last ? 4 : 0,
  };
}

/**
 * Content screens (settings, lists, reports) at a comfortable reading width on big screens
 * (iPad, landscape), centred; phones are narrower than this anyway.
 */
export const readable: ViewStyle = { width: '100%', maxWidth: 720, alignSelf: 'center' };

export function Row({
  title,
  subtitle,
  theme,
  icon,
  onPress,
  right,
  danger,
}: {
  title: string;
  subtitle?: string;
  theme: Theme;
  icon?: IconName;
  onPress?: () => void;
  right?: ReactNode;
  danger?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [styles.row, { backgroundColor: pressed ? theme.accentSoft : 'transparent' }]}>
      {icon ? <Icon name={icon} size={20} color={danger ? theme.danger : theme.muted} /> : null}
      <View style={styles.rowText}>
        <Text style={[styles.rowTitle, { color: danger ? theme.danger : theme.text }]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={[styles.rowSubtitle, { color: theme.muted }]} numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right}
    </Pressable>
  );
}

export function SwitchRow({
  title,
  subtitle,
  value,
  onValueChange,
  theme,
  disabled,
}: {
  title: string;
  subtitle?: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
  theme: Theme;
  disabled?: boolean;
}) {
  return (
    <Row
      title={title}
      subtitle={subtitle}
      theme={theme}
      onPress={disabled ? undefined : () => onValueChange(!value)}
      right={
        <Switch
          value={value}
          onValueChange={onValueChange}
          disabled={disabled}
          trackColor={{ true: theme.accent, false: theme.border }}
          thumbColor="#FFFFFF"
        />
      }
    />
  );
}

const styles = StyleSheet.create({
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  badge: {
    position: 'absolute',
    minWidth: 20,
    height: 20,
    borderRadius: 5,
    borderWidth: 1.6,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  badgeText: { fontSize: 11, fontWeight: '700' },
  backdrop: { backgroundColor: 'rgba(0,0,0,0.35)' },
  sheetHolder: { flex: 1, justifyContent: 'flex-end' },
  // Centred at a phone-like width on big screens (iPad), like the system's own sheets.
  sheet: { borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingTop: 8, maxHeight: '85%', width: '100%', maxWidth: 640, alignSelf: 'center' },
  grabber: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, marginBottom: 8 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 52,
    paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: { flex: 1, fontSize: 18, fontWeight: '600', marginLeft: 4 },
  headerRight: { flexDirection: 'row', alignItems: 'center', paddingRight: 4 },
  section: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: 28,
    paddingTop: 22,
    paddingBottom: 8,
  },
  group: { marginHorizontal: 16, borderRadius: 16, overflow: 'hidden', paddingVertical: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingVertical: 12, minHeight: 52 },
  rowText: { flex: 1 },
  rowTitle: { fontSize: 16 },
  rowSubtitle: { fontSize: 13, marginTop: 2 },
});
