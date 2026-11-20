import { TAIPEI_CORE_TOWNCODES } from './metro-focus';
import type { SavePayloadV2 } from '../save/types';

export type RegionId = 'northNorth' | 'northNorthTaoyuan';

export interface VillageAssetPair {
  topology: string;
  attributes: string;
}

export interface RegionDefinition {
  id: RegionId;
  name: string;
  countyCodes: readonly string[];
  villageAssets: readonly VillageAssetPair[];
  coreTownCodes: readonly string[];
}

export const DEFAULT_REGION_ID: RegionId = 'northNorth';

export const REGIONS: Readonly<Record<RegionId, RegionDefinition>> = {
  northNorth: {
    id: 'northNorth',
    name: '北北',
    countyCodes: ['63000', '65000'],
    villageAssets: [
      {
        topology: 'data/villages-6300065000.topo.json',
        attributes: 'data/villages-6300065000.json',
      },
    ],
    coreTownCodes: TAIPEI_CORE_TOWNCODES,
  },
  northNorthTaoyuan: {
    id: 'northNorthTaoyuan',
    name: '北北桃',
    countyCodes: ['63000', '65000', '68000'],
    villageAssets: [
      {
        topology: 'data/villages-6300065000.topo.json',
        attributes: 'data/villages-6300065000.json',
      },
      {
        topology: 'data/villages-68000.topo.json',
        attributes: 'data/villages-68000.json',
      },
    ],
    coreTownCodes: TAIPEI_CORE_TOWNCODES,
  },
};

export function isRegionId(value: unknown): value is RegionId {
  return value === 'northNorth' || value === 'northNorthTaoyuan';
}

export function regionIncludesCounty(region: RegionDefinition, countyCode: string): boolean {
  return region.countyCodes.includes(countyCode);
}

export function villageSourceFor(regionId: RegionId, baseUrl: URL) {
  const assets = REGIONS[regionId].villageAssets;
  if (regionId === DEFAULT_REGION_ID) {
    return { kind: 'url' as const, url: new URL(assets[0]!.attributes, baseUrl).href };
  }
  return {
    kind: 'urls' as const,
    urls: assets.map(({ attributes }) => new URL(attributes, baseUrl).href),
  };
}

export function extendRegionPayload(payload: SavePayloadV2, to: RegionId): SavePayloadV2 {
  if ((payload.region ?? DEFAULT_REGION_ID) !== 'northNorth' || to !== 'northNorthTaoyuan') {
    throw new Error('僅允許從北北延伸到北北桃。');
  }

  const extended: SavePayloadV2 = { ...payload, region: to };
  delete extended.transit;
  return extended;
}
