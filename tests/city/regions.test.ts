import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REGION_ID,
  REGIONS,
  isRegionId,
  regionIncludesCounty,
} from '../../src/city/regions';

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
});
