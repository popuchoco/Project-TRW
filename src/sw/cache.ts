export function buildCacheNames(appVersion: string, dataVersion: string): { shell: string; runtime: string } {
  const suffix = `v${appVersion}-d${dataVersion}`;
  return {
    shell: `trw-shell-${suffix}`,
    runtime: `trw-runtime-${suffix}`,
  };
}

/**
 * Cache lookups ignore `Vary`. Static hosts (and `vite preview`) answer with
 * `Vary: Origin`; precache requests carry no Origin header while the page's
 * `crossorigin` module scripts do, so a Vary-respecting match misses every
 * script chunk and the app cannot boot offline. All cached entries are
 * same-origin static files, so ignoring Vary is safe here.
 */
export const CACHE_MATCH_OPTIONS: CacheQueryOptions = { ignoreVary: true };
