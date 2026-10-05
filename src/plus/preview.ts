import type { PlusProduct } from '../../native/shield-webview/src/PlusStore';
import { PLUS_PRODUCTS } from './products';

/**
 * Example plans for TestFlight builds whose plans aren't available from the App Store yet:
 * the Plus screen can be seen (and photographed for App Review) before they are. Buying is
 * off in the preview; the real plans replace it as soon as they load.
 */
export const PREVIEW_PRODUCTS: PlusProduct[] = [
  {
    id: PLUS_PRODUCTS.yearly,
    displayName: 'Stillweb Plus Yearly',
    description: 'All Plus features, billed yearly.',
    displayPrice: '$19.99',
    price: 19.99,
    currencyCode: 'USD',
    type: 'subscription',
    period: { unit: 'year', value: 1 },
    introEligible: true,
    introOffer: { paymentMode: 'freeTrial', period: { unit: 'week', value: 2 }, periodCount: 1, displayPrice: '$0.00' },
  },
  {
    id: PLUS_PRODUCTS.monthly,
    displayName: 'Stillweb Plus Monthly',
    description: 'All Plus features, billed monthly.',
    displayPrice: '$2.99',
    price: 2.99,
    currencyCode: 'USD',
    type: 'subscription',
    period: { unit: 'month', value: 1 },
  },
  {
    id: PLUS_PRODUCTS.lifetime,
    displayName: 'Stillweb Plus Lifetime',
    description: 'All Plus features, forever. One payment.',
    displayPrice: '$49.99',
    price: 49.99,
    currencyCode: 'USD',
    type: 'lifetime',
  },
];

/** Plan names for messages about plans that aren't available. */
export const PLAN_NAMES: Record<string, string> = {
  [PLUS_PRODUCTS.yearly]: 'Yearly',
  [PLUS_PRODUCTS.monthly]: 'Monthly',
  [PLUS_PRODUCTS.lifetime]: 'Lifetime',
};
