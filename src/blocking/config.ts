/** Where .github/workflows/filters.yml publishes the filter bundle and the privacy policy. */
const PUBLISHED = 'https://roshan7211.github.io/Stillweb/';

/**
 * Where the app checks for new filter bundles: the manifest.json produced by
 * `npm run build:filters` and published daily by .github/workflows/filters.yml (GitHub
 * Pages). EXPO_PUBLIC_FILTER_MANIFEST_URL (in .env) points it elsewhere.
 */
export const FILTER_MANIFEST_URL: string | null = process.env.EXPO_PUBLIC_FILTER_MANIFEST_URL || `${PUBLISHED}manifest.json`;

/** Minimum time between update checks. */
export const FILTER_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export const FILTER_UPDATE_TASK = 'filter-update';

/** Public privacy policy (site/privacy/, published by the filters workflow). */
export const PRIVACY_POLICY_URL: string | null = process.env.EXPO_PUBLIC_PRIVACY_POLICY_URL || `${PUBLISHED}privacy/`;
