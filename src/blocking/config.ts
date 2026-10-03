/**
 * Where the app checks for new filter bundles: the manifest.json produced by
 * `npm run build:filters` and published by .github/workflows/filters.yml (GitHub Pages).
 * Set EXPO_PUBLIC_FILTER_MANIFEST_URL in .env. When unset, the app keeps using the
 * filter bundle that shipped inside it.
 */
export const FILTER_MANIFEST_URL: string | null = process.env.EXPO_PUBLIC_FILTER_MANIFEST_URL || null;

/** Minimum time between update checks. */
export const FILTER_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const FILTER_UPDATE_TASK = 'filter-update';

/** Public privacy policy (site/privacy/, published by the filters workflow). Optional. */
export const PRIVACY_POLICY_URL: string | null = process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL || null;
