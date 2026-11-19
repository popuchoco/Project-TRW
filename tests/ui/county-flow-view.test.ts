import { describe, expect, it } from 'vitest';
import type { CountyFlow } from '../../src/sim/transit/cross-city';
import { countyName, crossCityView } from '../../src/ui/county-flow-view';

describe('crossCityView', () => {
  it('returns an empty view when flows are undefined', () => {
    expect(crossCityView(undefined)).toEqual({
      trips: '—',
      fareRevenue: '—',
      topPairs: [],
    });
  });

  it('excludes same-county flows from the totals and pairs', () => {
    const flows: CountyFlow[] = [
      { originCounty: '63000', destinationCounty: '63000', trips: 120, fareRevenue: 2400 },
    ];

    expect(crossCityView(flows)).toEqual({
      trips: '0 人次（模擬值）',
      fareRevenue: 'NT$0（模擬值）',
      topPairs: [],
    });
  });

  it('returns the three largest cross-county pairs with stable tie ordering', () => {
    const flows: CountyFlow[] = [
      { originCounty: '68000', destinationCounty: '63000', trips: 1234, fareRevenue: 12340 },
      { originCounty: '65000', destinationCounty: '63000', trips: 900, fareRevenue: 9000 },
      { originCounty: '63000', destinationCounty: '65000', trips: 700, fareRevenue: 7000 },
      { originCounty: '63000', destinationCounty: '68000', trips: 700, fareRevenue: 7000 },
      { originCounty: '63000', destinationCounty: '63000', trips: 5000, fareRevenue: 50000 },
    ];

    expect(crossCityView(flows)).toEqual({
      trips: '3,534 人次（模擬值）',
      fareRevenue: 'NT$35,340（模擬值）',
      topPairs: [
        '桃園市→臺北市 1,234 人',
        '新北市→臺北市 900 人',
        '臺北市→新北市 700 人',
      ],
    });
  });

  it('uses unknown county codes as their display names', () => {
    expect(countyName('99999')).toBe('99999');
    expect(crossCityView([
      { originCounty: '99999', destinationCounty: '63000', trips: 1, fareRevenue: 25 },
    ]).topPairs).toEqual(['99999→臺北市 1 人']);
  });
});
