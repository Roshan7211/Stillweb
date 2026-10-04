import type { Tab } from './tabs';

/** Stillweb Plus profile: tabs in it share their own cookies, logins and site data. */
export type Profile = { id: string; name: string };

/** Name of the profile every tab starts in (it has no id). */
export const DEFAULT_PROFILE_NAME = 'Personal';
export const MAX_PROFILES = 8;
export const MAX_PROFILE_NAME = 24;

/** Random UUID v4: the native side names the profile's data store after it. */
export function newProfileId(): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16));
  hex[12] = 4;
  hex[16] = (hex[16] & 0x3) | 0x8;
  const s = hex.map((n) => n.toString(16)).join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** The profile a normal tab is shown under (null = the default one, also for unknown ids). */
export function profileOf(tab: Pick<Tab, 'profileId'>, profiles: Profile[]): string | null {
  return tab.profileId && profiles.some((p) => p.id === tab.profileId) ? tab.profileId : null;
}

export function profileName(id: string | null, profiles: Profile[]): string {
  return (id && profiles.find((p) => p.id === id)?.name) || DEFAULT_PROFILE_NAME;
}
