/**
 * Product ids for Stillweb Plus, the same in both stores.
 *
 * App Store Connect (the Paid Apps agreement must be active):
 * - Subscription group "Stillweb Plus" with `yearly` (1 year, 14-day free trial as an
 *   introductory offer) and `monthly` (1 month).
 * - Non-consumable `lifetime`.
 * Family Sharing stays off for all three: Plus belongs to the Apple Account that bought it.
 *
 * Google Play Console (a payments profile must be set up; a build with the billing library
 * must be uploaded to a test track first):
 * - Subscriptions `yearly` and `monthly`, each with one auto-renewing base plan. The free
 *   trial is an offer on the yearly base plan (new customers, 14 days free).
 * - One-time product `lifetime` (not consumed).
 *
 * Until they exist (or can't be reached) the Plus screen shows that plans couldn't be loaded.
 */
export const PLUS_PRODUCTS = {
  yearly: 'app.stillweb.browser.plus.yearly',
  monthly: 'app.stillweb.browser.plus.monthly',
  lifetime: 'app.stillweb.browser.plus.lifetime',
} as const;
