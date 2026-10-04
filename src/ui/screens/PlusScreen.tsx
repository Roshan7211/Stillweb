import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PRIVACY_POLICY_URL } from '../../blocking/config';
import { PLUS_PRODUCTS, usePlus } from '../../plus/plus';
import { formatPrice, hasTrial, planTerms, planTitle } from '../../plus/pricing';
import { Icon, IconButton, type IconName } from '../components/primitives';
import type { Theme } from '../theme';

type Props = { theme: Theme; onBack: () => void; onOpen: (url: string) => void };

/** What Plus includes today. Only features that exist are listed (App Store rule 3.1.2). */
const PLUS_FEATURES: { icon: IconName; title: string; body: string }[] = [
  {
    icon: 'sun',
    title: 'Calm Mode',
    body: 'Cookie pop-ups rejected for you, and newsletter pop-ups, chat bubbles and floating videos hidden.',
  },
  {
    icon: 'headphones',
    title: 'Listen Mode',
    body: 'Playback speed and a sleep timer for audio and video on any site, also with the screen locked.',
  },
  {
    icon: 'crosshair',
    title: 'Fix-it tools',
    body: 'Hide anything on a page with a tap, and turn JavaScript off for sites that misbehave.',
  },
  {
    icon: 'lock',
    title: 'Private vault',
    body: 'Bookmarks and downloads from private tabs, locked with Face ID and kept out of your other lists and the Files app.',
  },
  {
    icon: 'bar-chart-2',
    title: 'Full privacy report',
    body: 'A year of history, the sites you’re protected on most and the trackers blocked most often.',
  },
  {
    icon: 'heart',
    title: 'Keep Stillweb independent',
    body: 'No ads and no selling data: Stillweb is paid for by Plus. Ad blocking always stays free.',
  },
];

/** Apple's standard licence agreement, used as Stillweb's Terms of Use. */
const TERMS_URL = 'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/';

export default function PlusScreen({ theme, onBack, onOpen }: Props) {
  const plus = usePlus();
  const [selected, setSelected] = useState<string>(PLUS_PRODUCTS.yearly);
  const [busy, setBusy] = useState<'purchase' | 'restore' | null>(null);

  const { productsState, loadProducts } = plus;
  useEffect(() => {
    if (productsState === 'idle' || productsState === 'error') loadProducts();
    // Once when the screen opens; Try again reloads after a failure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const products = plus.products;
  const chosen = products.find((p) => p.id === selected) ?? products[0];
  const monthly = products.find((p) => p.id === PLUS_PRODUCTS.monthly);
  const yearly = products.find((p) => p.id === PLUS_PRODUCTS.yearly);
  const yearlySaving = monthly && yearly ? Math.round((1 - yearly.price / (monthly.price * 12)) * 100) : 0;

  const buy = async () => {
    if (!chosen || busy) return;
    setBusy('purchase');
    const result = await plus.purchase(chosen.id);
    setBusy(null);
    if (result.status === 'purchased') {
      Alert.alert('Welcome to Stillweb Plus', 'Thank you for supporting Stillweb.');
    } else if (result.status === 'pending') {
      Alert.alert('Purchase pending', 'It finishes once it’s approved, for example by a parent with Ask to Buy.');
    } else if (result.status === 'error') {
      Alert.alert('Purchase didn’t go through', result.message);
    }
  };

  const restore = async () => {
    if (busy) return;
    setBusy('restore');
    try {
      const found = await plus.restore();
      Alert.alert(
        found ? 'Purchases restored' : 'Nothing to restore',
        found ? 'Stillweb Plus is active.' : 'No Stillweb Plus purchase was found for this Apple Account.',
      );
    } catch (e) {
      Alert.alert('Couldn’t restore purchases', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const entitlement = plus.entitlement;
  const isLifetime = entitlement?.productId === PLUS_PRODUCTS.lifetime;

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: theme.background }]} edges={['top', 'bottom', 'left', 'right']}>
      <View style={styles.close}>
        <IconButton name="x" label="Close" color={theme.text} onPress={onBack} />
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={[styles.badge, { backgroundColor: theme.accentSoft }]}>
          <Icon name="shield" size={30} color={theme.accent} />
        </View>
        <Text style={[styles.title, { color: theme.text }]}>Stillweb Plus</Text>
        <Text style={[styles.subtitle, { color: theme.muted }]}>More from your browser. Ad blocking always stays free.</Text>

        <View style={styles.features}>
          {PLUS_FEATURES.map((f) => (
            <View key={f.title} style={styles.feature}>
              <Icon name={f.icon} size={22} color={theme.accent} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.featureTitle, { color: theme.text }]}>{f.title}</Text>
                <Text style={[styles.featureBody, { color: theme.muted }]}>{f.body}</Text>
              </View>
            </View>
          ))}
        </View>

        {entitlement ? (
          <View style={[styles.active, { backgroundColor: theme.surface }]}>
            <Icon name="check-circle" size={24} color={theme.accent} />
            <Text style={[styles.activeTitle, { color: theme.text }]}>You have Stillweb Plus</Text>
            <Text style={[styles.activeBody, { color: theme.muted }]}>
              {isLifetime
                ? 'Yours for life. Thank you!'
                : entitlement.expiresAt
                  ? `Current period ends ${new Date(entitlement.expiresAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}.`
                  : 'Thank you for supporting Stillweb.'}
            </Text>
            {!isLifetime ? (
              <Pressable onPress={plus.manageSubscription} accessibilityRole="button" hitSlop={8}>
                <Text style={[styles.link, { color: theme.accent }]}>Manage subscription</Text>
              </Pressable>
            ) : null}
          </View>
        ) : productsState === 'ready' && chosen ? (
          <>
            <View style={styles.plans}>
              {products.map((product) => {
                const active = product.id === chosen.id;
                const perMonth =
                  product.id === PLUS_PRODUCTS.yearly ? formatPrice(product.price / 12, product.currencyCode) : null;
                return (
                  <Pressable
                    key={product.id}
                    onPress={() => setSelected(product.id)}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: active }}
                    style={[styles.plan, { borderColor: active ? theme.accent : theme.border, backgroundColor: theme.surface }]}>
                    <Icon name={active ? 'check-circle' : 'circle'} size={22} color={active ? theme.accent : theme.muted} />
                    <View style={{ flex: 1 }}>
                      <View style={styles.planHeader}>
                        <Text style={[styles.planTitle, { color: theme.text }]}>{planTitle(product)}</Text>
                        {product.id === PLUS_PRODUCTS.yearly && yearlySaving > 0 ? (
                          <Text style={[styles.save, { color: theme.accent, backgroundColor: theme.accentSoft }]}>
                            Save {yearlySaving}%
                          </Text>
                        ) : null}
                      </View>
                      <Text style={[styles.planTerms, { color: theme.text }]}>{planTerms(product)}</Text>
                      {perMonth ? <Text style={[styles.planNote, { color: theme.muted }]}>{perMonth} a month</Text> : null}
                    </View>
                  </Pressable>
                );
              })}
            </View>

            <Pressable
              onPress={buy}
              disabled={!!busy}
              accessibilityRole="button"
              style={[styles.cta, { backgroundColor: theme.accent, opacity: busy ? 0.7 : 1 }]}>
              {busy === 'purchase' ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.ctaText}>
                  {hasTrial(chosen) ? 'Start free trial' : chosen.type === 'lifetime' ? 'Buy Lifetime' : 'Subscribe'}
                </Text>
              )}
            </Pressable>
            <Text style={[styles.legal, { color: theme.muted }]}>
              {chosen.type === 'lifetime'
                ? 'One-time purchase, charged to your Apple Account.'
                : `Payment is charged to your Apple Account${hasTrial(chosen) ? ' when the free trial ends' : ''}. The subscription renews automatically unless it’s cancelled at least 24 hours before the end of the current period. Manage or cancel it in Settings › Apple Account › Subscriptions.`}
            </Text>
          </>
        ) : productsState === 'error' ? (
          <View style={styles.status}>
            <Text style={[styles.statusText, { color: theme.muted }]}>Plans couldn’t be loaded. Check your connection.</Text>
            <Pressable onPress={loadProducts} accessibilityRole="button" hitSlop={8}>
              <Text style={[styles.link, { color: theme.accent }]}>Try again</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.status}>
            <ActivityIndicator color={theme.muted} />
          </View>
        )}

        <View style={styles.footer}>
          <Pressable onPress={restore} disabled={!!busy} accessibilityRole="button" hitSlop={8}>
            <Text style={[styles.footerLink, { color: theme.accent }]}>{busy === 'restore' ? 'Restoring…' : 'Restore Purchases'}</Text>
          </Pressable>
          <Pressable onPress={plus.redeemCode} accessibilityRole="button" hitSlop={8}>
            <Text style={[styles.footerLink, { color: theme.accent }]}>Redeem Code</Text>
          </Pressable>
        </View>
        <View style={styles.footer}>
          <Pressable onPress={() => onOpen(TERMS_URL)} accessibilityRole="link" hitSlop={8}>
            <Text style={[styles.footerLink, { color: theme.muted }]}>Terms of Use</Text>
          </Pressable>
          {PRIVACY_POLICY_URL ? (
            <Pressable onPress={() => onOpen(PRIVACY_POLICY_URL as string)} accessibilityRole="link" hitSlop={8}>
              <Text style={[styles.footerLink, { color: theme.muted }]}>Privacy Policy</Text>
            </Pressable>
          ) : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  close: { alignItems: 'flex-end', paddingHorizontal: 4 },
  content: { paddingHorizontal: 20, paddingBottom: 40 },
  badge: { alignSelf: 'center', width: 64, height: 64, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 28, fontWeight: '700', textAlign: 'center', marginTop: 14 },
  subtitle: { fontSize: 15, textAlign: 'center', marginTop: 6, lineHeight: 21 },
  features: { marginTop: 24, gap: 18 },
  feature: { flexDirection: 'row', gap: 14 },
  featureTitle: { fontSize: 16, fontWeight: '600' },
  featureBody: { fontSize: 14, lineHeight: 20, marginTop: 2 },
  plans: { marginTop: 28, gap: 10 },
  plan: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 14, borderWidth: 1.5 },
  planHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  planTitle: { fontSize: 16, fontWeight: '600' },
  save: { fontSize: 12, fontWeight: '700', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8, overflow: 'hidden' },
  planTerms: { fontSize: 15, marginTop: 2 },
  planNote: { fontSize: 13, marginTop: 2 },
  cta: { marginTop: 20, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
  ctaText: { color: '#FFFFFF', fontSize: 17, fontWeight: '600' },
  legal: { fontSize: 12, lineHeight: 17, textAlign: 'center', marginTop: 12 },
  active: { marginTop: 28, padding: 20, borderRadius: 18, alignItems: 'center', gap: 6 },
  activeTitle: { fontSize: 17, fontWeight: '600' },
  activeBody: { fontSize: 14, textAlign: 'center' },
  status: { marginTop: 32, alignItems: 'center', gap: 10 },
  statusText: { fontSize: 15, textAlign: 'center' },
  link: { fontSize: 15, fontWeight: '600', marginTop: 4 },
  footer: { flexDirection: 'row', justifyContent: 'center', gap: 24, marginTop: 20 },
  footerLink: { fontSize: 14 },
});
