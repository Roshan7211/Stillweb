import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { PlusStore, type PlusEntitlement, type PlusProduct } from '../../native/shield-webview';
import { PLUS_PRODUCTS } from './products';

export { PLUS_PRODUCTS };

const PRODUCT_ORDER: string[] = [PLUS_PRODUCTS.yearly, PLUS_PRODUCTS.monthly, PLUS_PRODUCTS.lifetime];
const CACHE_KEY = 'plus.unlocked.v1';

export type PurchaseResult = { status: 'purchased' | 'pending' | 'cancelled' } | { status: 'error'; message: string };

type PlusValue = {
  /** Plus can be bought on this device. */
  supported: boolean;
  /**
   * Plus features are available: bought with this Apple Account. Where Plus can't be bought
   * yet (Android) its features aren't locked.
   */
  unlocked: boolean;
  /** The active purchase (lifetime first, then the subscription that runs longest). */
  entitlement: PlusEntitlement | null;
  products: PlusProduct[];
  productsState: 'idle' | 'loading' | 'ready' | 'error';
  loadProducts: () => void;
  purchase: (productId: string) => Promise<PurchaseResult>;
  /** Restore Purchases; resolves with whether Plus is now active. */
  restore: () => Promise<boolean>;
  manageSubscription: () => void;
  redeemCode: () => void;
};

const PlusContext = createContext<PlusValue | null>(null);

function pickEntitlement(list: PlusEntitlement[]): PlusEntitlement | null {
  const ours = list.filter((e) => PRODUCT_ORDER.includes(e.productId));
  const lifetime = ours.find((e) => e.productId === PLUS_PRODUCTS.lifetime);
  if (lifetime) return lifetime;
  return ours.sort((a, b) => (b.expiresAt ?? 0) - (a.expiresAt ?? 0))[0] ?? null;
}

export function PlusProvider({ children }: { children: ReactNode }) {
  const supported = PlusStore !== null;
  const [entitlement, setEntitlement] = useState<PlusEntitlement | null>(null);
  // Last known state, so Plus screens don't flash locked at launch; StoreKit then confirms.
  const [cachedUnlocked, setCachedUnlocked] = useState(false);
  const [verified, setVerified] = useState(false);
  const [products, setProducts] = useState<PlusProduct[]>([]);
  const [productsState, setProductsState] = useState<PlusValue['productsState']>('idle');

  const apply = useCallback((list: PlusEntitlement[]) => {
    const active = pickEntitlement(list);
    setEntitlement(active);
    setVerified(true);
    AsyncStorage.setItem(CACHE_KEY, active ? '1' : '0').catch(() => {});
  }, []);

  useEffect(() => {
    if (!PlusStore) return;
    AsyncStorage.getItem(CACHE_KEY)
      .then((value) => setCachedUnlocked(value === '1'))
      .catch(() => {});
    PlusStore.getEntitlements().then(apply).catch(() => {});
    const sub = PlusStore.addListener('onEntitlementsChanged', ({ entitlements }) => apply(entitlements));
    return () => sub.remove();
  }, [apply]);

  const loadProducts = useCallback(() => {
    if (!PlusStore) return;
    setProductsState('loading');
    PlusStore.getProducts(PRODUCT_ORDER)
      .then((list) => {
        setProducts([...list].sort((a, b) => PRODUCT_ORDER.indexOf(a.id) - PRODUCT_ORDER.indexOf(b.id)));
        setProductsState(list.length ? 'ready' : 'error');
      })
      .catch(() => setProductsState('error'));
  }, []);

  const purchase = useCallback(
    async (productId: string): Promise<PurchaseResult> => {
      if (!PlusStore) return { status: 'error', message: 'Purchases aren’t available on this device.' };
      try {
        const outcome = await PlusStore.purchase(productId);
        apply(outcome.entitlements);
        return { status: outcome.status };
      } catch (e) {
        return { status: 'error', message: e instanceof Error ? e.message : String(e) };
      }
    },
    [apply],
  );

  const restore = useCallback(async () => {
    if (!PlusStore) return false;
    const list = await PlusStore.restore();
    apply(list);
    return pickEntitlement(list) !== null;
  }, [apply]);

  const manageSubscription = useCallback(() => {
    PlusStore?.showManageSubscriptions().catch(() => {});
  }, []);

  const redeemCode = useCallback(() => {
    PlusStore?.presentOfferCodeRedeemSheet().catch(() => {});
  }, []);

  const unlocked = !supported || entitlement !== null || (!verified && cachedUnlocked);

  const value = useMemo<PlusValue>(
    () => ({ supported, unlocked, entitlement, products, productsState, loadProducts, purchase, restore, manageSubscription, redeemCode }),
    [supported, unlocked, entitlement, products, productsState, loadProducts, purchase, restore, manageSubscription, redeemCode],
  );
  return <PlusContext.Provider value={value}>{children}</PlusContext.Provider>;
}

export function usePlus(): PlusValue {
  const ctx = useContext(PlusContext);
  if (!ctx) throw new Error('usePlus must be used inside PlusProvider');
  return ctx;
}
