import type { PlusPeriod, PlusProduct } from '../../native/shield-webview/src/PlusStore';
import { PLUS_PRODUCTS } from './products';

/** Days that make whole weeks read as weeks (StoreKit may report a week as 7 days). */
function normalize(unit: PlusPeriod['unit'], count: number): { unit: PlusPeriod['unit']; count: number } {
  return unit === 'day' && count % 7 === 0 ? { unit: 'week', count: count / 7 } : { unit, count };
}

/** Billing period after a price: "year", "month", "3 months". */
export function perPeriod(period: PlusPeriod): string {
  const { unit, count } = normalize(period.unit, period.value);
  return count === 1 ? unit : `${count} ${unit}s`;
}

/** A length of time: "1 week", "14 days", "3 months". */
export function duration(period: PlusPeriod, times = 1): string {
  const { unit, count } = normalize(period.unit, period.value * times);
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

export function formatPrice(amount: number, currencyCode: string): string | null {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currencyCode }).format(amount);
  } catch {
    return null;
  }
}

export function hasTrial(product: PlusProduct): boolean {
  return !!product.introEligible && product.introOffer?.paymentMode === 'freeTrial';
}

export function planTitle(product: PlusProduct): string {
  if (product.id === PLUS_PRODUCTS.yearly) return 'Yearly';
  if (product.id === PLUS_PRODUCTS.monthly) return 'Monthly';
  if (product.id === PLUS_PRODUCTS.lifetime) return 'Lifetime';
  return product.displayName;
}

/** Price line, with the trial terms where the account can still get them. */
export function planTerms(product: PlusProduct): string {
  if (product.type === 'lifetime' || !product.period) return `${product.displayPrice} once`;
  const per = `${product.displayPrice} / ${perPeriod(product.period)}`;
  if (hasTrial(product) && product.introOffer) {
    const offer = product.introOffer;
    return `Free for ${duration(offer.period, offer.periodCount)}, then ${per}`;
  }
  return per;
}
