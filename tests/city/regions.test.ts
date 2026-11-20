import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REGION_ID,
  REGIONS,
  extendRegionPayload,
  isRegionId,
  regionIncludesCounty,
  villageSourceFor,
} from '../../src/city/regions';
import type { SavePayloadV2 } from '../../src/save/types';

describe('regions', () => {
  it('defines counties and village assets in county order', () => {
    expect(DEFAULT_REGION_ID).toBe('northNorth');
    expect(REGIONS.northNorth.countyCodes).toEqual(['63000', '65000']);
    expect(REGIONS.northNorthTaoyuan.countyCodes).toEqual(['63000', '65000', '68000']);
    expect(REGIONS.northNorth.villageAssets).toEqual([
      {
        topology: 'data/villages-6300065000.topo.json',
        attributes: 'data/villages-6300065000.json',
      },
    ]);
    expect(REGIONS.northNorthTaoyuan.villageAssets).toEqual([
      {
        topology: 'data/villages-6300065000.topo.json',
        attributes: 'data/villages-6300065000.json',
      },
      {
        topology: 'data/villages-68000.topo.json',
        attributes: 'data/villages-68000.json',
      },
    ]);
  });

  it('recognizes only supported region IDs', () => {
    expect(isRegionId('northNorth')).toBe(true);
    expect(isRegionId('northNorthTaoyuan')).toBe(true);
    expect(isRegionId('taoyuan')).toBe(false);
    expect(isRegionId(undefined)).toBe(false);
    expect(isRegionId(null)).toBe(false);
  });

  it('checks county membership', () => {
    expect(regionIncludesCounty(REGIONS.northNorthTaoyuan, '68000')).toBe(true);
    expect(regionIncludesCounty(REGIONS.northNorth, '68000')).toBe(false);
  });

  it('builds absolute village source URLs under the supplied base URL', () => {
    const baseUrl = new URL('http://x/trw/');

    const northNorth = villageSourceFor('northNorth', baseUrl);
    expect(northNorth).toEqual({
      kind: 'url',
      url: 'http://x/trw/data/villages-6300065000.json',
    });

    const northNorthTaoyuan = villageSourceFor('northNorthTaoyuan', baseUrl);
    expect(northNorthTaoyuan).toEqual({
      kind: 'urls',
      urls: [
        'http://x/trw/data/villages-6300065000.json',
        'http://x/trw/data/villages-68000.json',
      ],
    });
    const urls = northNorthTaoyuan.kind === 'urls' ? northNorthTaoyuan.urls : [];
    expect(urls.every((url) => url.startsWith('http://x/trw/data/'))).toBe(true);
  });

  it('extends a north-north payload to Taoyuan and removes transit state', () => {
    const payload = {
      region: 'northNorth',
      network: { id: 'network' },
      camera: { x: 1, y: 2, zoom: 3 },
      view: 'metro',
      simulation: { gameTimeMs: 1 },
      stats: { passengers: 4 },
      transit: { history: [1] },
    } as unknown as SavePayloadV2;

    const extended = extendRegionPayload(payload, 'northNorthTaoyuan');

    expect(extended).toEqual({
      region: 'northNorthTaoyuan',
      network: payload.network,
      camera: payload.camera,
      view: payload.view,
      simulation: payload.simulation,
      stats: payload.stats,
    });
    expect(Object.hasOwn(extended, 'transit')).toBe(false);
    expect(extended.network).toBe(payload.network);
    expect(extended.camera).toBe(payload.camera);
    expect(extended.simulation).toBe(payload.simulation);
    expect(extended.stats).toBe(payload.stats);
  });

  it('does not mutate the original payload', () => {
    const payload = {
      region: 'northNorth',
      network: {},
      camera: { x: 0, y: 0, zoom: 1 },
      view: 'island',
      simulation: {},
      stats: {},
      transit: { history: [] },
    } as unknown as SavePayloadV2;
    const original = { ...payload };

    extendRegionPayload(payload, 'northNorthTaoyuan');

    expect(payload).toEqual(original);
  });

  it('rejects unsupported region transitions', () => {
    const payload = {
      region: 'northNorthTaoyuan',
      network: {},
      camera: { x: 0, y: 0, zoom: 1 },
      view: 'island',
      simulation: {},
      stats: {},
    } as unknown as SavePayloadV2;

    expect(() => extendRegionPayload(payload, 'northNorth')).toThrow();
  });
});

describe('region village assets (review H-1)', () => {
  it('point at files that exist in public/data and are precached', async () => {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const { buildPrecacheList } = await import('../../src/sw/precache');
    const precache = new Set(buildPrecacheList([]));
    for (const region of Object.values(REGIONS)) {
      for (const asset of region.villageAssets) {
        for (const path of [asset.topology, asset.attributes]) {
          expect(existsSync(resolve(__dirname, '../../public', path)), path).toBe(true);
          expect(precache.has(`./${path}`), path).toBe(true);
        }
      }
    }
  });
});
