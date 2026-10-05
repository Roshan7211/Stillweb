import { NativeModule, requireOptionalNativeModule } from 'expo';

export type PlusPeriod = { unit: 'day' | 'week' | 'month' | 'year'; value: number };

export type PlusProduct = {
  id: string;
  displayName: string;
  description: string;
  /** Localized price, e.g. "$14.99". */
  displayPrice: string;
  price: number;
  currencyCode: string;
  type: 'subscription' | 'lifetime';
  period?: PlusPeriod;
  /** Whether this Apple Account can still get the introductory offer (free trial). */
  introEligible?: boolean;
  introOffer?: {
    paymentMode: 'freeTrial' | 'payAsYouGo' | 'payUpFront' | 'other';
    period: PlusPeriod;
    periodCount: number;
    displayPrice: string;
  };
};

export type PlusEntitlement = {
  productId: string;
  purchasedAt: number;
  /** Subscriptions only (ms since epoch). */
  expiresAt?: number;
};

export type PurchaseOutcome = {
  status: 'purchased' | 'pending' | 'cancelled';
  entitlements: PlusEntitlement[];
};

type PlusStoreEvents = {
  onEntitlementsChanged: (event: { entitlements: PlusEntitlement[] }) => void;
};

declare class PlusStoreModule extends NativeModule<PlusStoreEvents> {
  /** TestFlight or development build (sandbox purchases), not the App Store. */
  readonly sandbox?: boolean;
  getProducts(ids: string[]): Promise<PlusProduct[]>;
  purchase(id: string): Promise<PurchaseOutcome>;
  getEntitlements(): Promise<PlusEntitlement[]>;
  /** Syncs with the App Store ("Restore Purchases"); may ask the user to sign in. */
  restore(): Promise<PlusEntitlement[]>;
  showManageSubscriptions(): Promise<boolean>;
  presentOfferCodeRedeemSheet(): Promise<boolean>;
}

/** StoreKit purchases (iOS). Null where Stillweb Plus can't be bought (Android, for now). */
export default requireOptionalNativeModule<PlusStoreModule>('PlusStore');
