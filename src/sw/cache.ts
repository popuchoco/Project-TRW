export interface CacheNamePair {
  shell: string;
  runtime: string;
}

export interface CacheStorageKeys {
  keys(): Promise<string[]>;
  delete(cacheName: string): Promise<boolean>;
}

export function buildCacheNames(appVersion: string, dataVersions: string, buildHash: string): CacheNamePair {
  const suffix = `v${appVersion}-d${dataVersions}-b${buildHash}`;
  return {
    shell: `trw-shell-${suffix}`,
    runtime: `trw-runtime-${suffix}`,
  };
}

export async function deleteObsoleteTrwCaches(cacheStorage: CacheStorageKeys, currentNames: CacheNamePair): Promise<void> {
  const current = new Set([currentNames.shell, currentNames.runtime]);
  const obsolete = (await cacheStorage.keys()).filter((name) => name.startsWith("trw-") && !current.has(name));
  await Promise.all(obsolete.map((name) => cacheStorage.delete(name)));
}

/**
 * Cache lookups ignore `Vary`. Static hosts (and `vite preview`) answer with
 * `Vary: Origin`; precache requests carry no Origin header while the page's
 * `crossorigin` module scripts do, so a Vary-respecting match misses every
 * script chunk and the app cannot boot offline. All cached entries are
 * same-origin static files, so ignoring Vary is safe here.
 */
export const CACHE_MATCH_OPTIONS: CacheQueryOptions = { ignoreVary: true };
