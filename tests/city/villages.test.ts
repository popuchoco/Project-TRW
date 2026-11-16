import { describe, expect, it } from 'vitest';
import { createVillageAtLookup } from '../../src/city/villages';

describe('village coordinate lookup', () => {
  it('uses the shared point-in-polygon helper for village geometry', () => {
    const lookup = createVillageAtLookup([
      {
        name: '東里',
        townName: '甲區',
        geometry: {
          type: 'MultiPolygon',
          coordinates: [[[
            [121, 25], [122, 25], [122, 26], [121, 26], [121, 25],
          ]]],
        },
      },
    ]);

    expect(lookup(121.5, 25.5)).toEqual({ name: '東里', townName: '甲區' });
    expect(lookup(123, 25.5)).toBeUndefined();
  });
});
