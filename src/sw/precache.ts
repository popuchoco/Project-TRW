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
  // 北北都會細層的地圖細節（M-1 延伸）：LOD2 全島＋北北視圖（初始框與「顯示全北北」）
  // 會載入的 LOD3 縣市：臺北、新北、基隆、桃園、宜蘭、新竹縣、苗栗、新竹市。
  // 其他 LOD3 仍走 runtime cache。
  "./data/trw-1140318-lod2.topo.json",
  "./data/lod3/63000.topo.json",
  "./data/lod3/65000.topo.json",
  "./data/lod3/10017.topo.json",
  "./data/lod3/68000.topo.json",
  "./data/lod3/10002.topo.json",
  "./data/lod3/10004.topo.json",
  "./data/lod3/10005.topo.json",
  "./data/lod3/10018.topo.json",
] as const;

export function buildPrecacheList(generatedAssets: readonly string[]): string[] {
  return [...STATIC_PRECACHE, ...generatedAssets]
    .filter((path, index, all) => all.indexOf(path) === index)
    .sort((left, right) => left === "./index.html" ? -1 : right === "./index.html" ? 1 : left < right ? -1 : left > right ? 1 : 0);
}
