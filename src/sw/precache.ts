const STATIC_PRECACHE = [
  "./index.html",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./data/manifest.json",
  "./data/trw-1140318-lod0.topo.json",
  "./data/trw-1140318-lod1.topo.json",
  "./data/trw-1140318-insets.topo.json",
  "./data/villages-manifest.json",
  "./data/villages-6300065000.json",
  "./data/villages-6300065000.topo.json",
] as const;

export function buildPrecacheList(generatedAssets: readonly string[]): string[] {
  return [...STATIC_PRECACHE, ...generatedAssets]
    .filter((path, index, all) => all.indexOf(path) === index)
    .sort((left, right) => left === "./index.html" ? -1 : right === "./index.html" ? 1 : left < right ? -1 : left > right ? 1 : 0);
}
