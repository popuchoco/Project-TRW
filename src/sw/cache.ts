export function buildCacheNames(appVersion: string, dataVersion: string): { shell: string; runtime: string } {
  const suffix = `v${appVersion}-d${dataVersion}`;
  return {
    shell: `trw-shell-${suffix}`,
    runtime: `trw-runtime-${suffix}`,
  };
}
