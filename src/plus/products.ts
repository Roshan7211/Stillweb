/**
 * App Store Connect product ids for Stillweb Plus. Set up in App Store Connect (the Paid Apps
 * agreement must be active):
 *
 * - Subscription group "Stillweb Plus" with `yearly` (1 year, 14-day free trial as an
 *   introductory offer) and `monthly` (1 month).
 * - Non-consumable `lifetime`.
 *
 * Family Sharing stays off for all three: Plus belongs to the Apple Account that bought it.
 *
 * Until they exist (or can't be reached) the Plus screen shows that plans couldn't be loaded.
 */
export const PLUS_PRODUCTS = {
  yearly: 'app.stillweb.browser.plus.yearly',
  monthly: 'app.stillweb.browser.plus.monthly',
  lifetime: 'app.stillweb.browser.plus.lifetime',
} as const;
