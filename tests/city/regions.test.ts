import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REGION_ID,
  REGIONS,
  extendRegionPayload,
  isRegionId,
  regionIncludesCounty,
} from '../../src/city/regions';
import type { SavePayloadV2 } from '../../src/save/types';

describe('regions', () => {
  it('defines counties and village assets in county order', () => {
    expect(DEFAULT_REGION_ID).toBe('northNorth');
    expect(REGIONS.northNorth.countyCodes).toEqual(['63000', '65000']);
    expect(REGIONS.northNorthTaoyuan.countyCodes).toEqual(['63000', '65000', '68000']);
    expect(REGIONS.northNorth.villageAssets).toEqual([
      {
        topology: 'data/villages-northNorth.topology.json',
        attributes: 'data/villages-northNorth.json',
      },
    ]);
    expect(REGIONS.northNorthTaoyuan.villageAssets).toEqual([
      {
        topology: 'data/villages-northNorth.topology.json',
        attributes: 'data/villages-northNorth.json',
      },
      {
        topology: 'data/villages-68000.topology.json',
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
