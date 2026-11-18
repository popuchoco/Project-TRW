import { describe, expect, it } from 'vitest';
import {
  addCountyFlow,
  countyOfVillage,
  scaleCountyFlows,
  summarizeCountyFlows,
  type CountyFlow,
} from '../../src/sim/transit/cross-city';

describe('cross-city county flows', () => {
  it('takes the first five characters as the county code', () => {
    expect(countyOfVillage('6800001234')).toBe('68000');
  });

  it('aggregates village flows into county flows', () => {
    const flows = new Map<string, CountyFlow>();
    addCountyFlow(flows, '6800001', '6800002', 4, 40);
    addCountyFlow(flows, '6800002', '6800003', 3, 30);
    addCountyFlow(flows, '6800002', '6600001', 5, 100);

    expect([...flows.values()]).toEqual([
      { originCounty: '68000', destinationCounty: '68000', trips: 7, fareRevenue: 70 },
      { originCounty: '68000', destinationCounty: '66000', trips: 5, fareRevenue: 100 },
    ]);
  });

  it('scales trips and fare revenue by an accepted-to-desired ratio', () => {
    const flows = new Map<string, CountyFlow>();
    addCountyFlow(flows, '6800001', '6600001', 5, 100);
    addCountyFlow(flows, '6800002', '6800003', 7, 70);

    expect(scaleCountyFlows(flows, 0.4)).toEqual([
      { originCounty: '68000', destinationCounty: '66000', trips: 2, fareRevenue: 40 },
      { originCounty: '68000', destinationCounty: '68000', trips: 2.8000000000000003, fareRevenue: 28 },
    ]);
  });

  it('summarizes only cross-city flows and sorts by origin then destination', () => {
    const flows: CountyFlow[] = [
      { originCounty: '68000', destinationCounty: '68000', trips: 7, fareRevenue: 70 },
      { originCounty: '66000', destinationCounty: '68000', trips: 2, fareRevenue: 50 },
      { originCounty: '68000', destinationCounty: '66000', trips: 5, fareRevenue: 100 },
    ];

    expect(summarizeCountyFlows(flows)).toEqual({
      flows: [
        { originCounty: '66000', destinationCounty: '68000', trips: 2, fareRevenue: 50 },
        { originCounty: '68000', destinationCounty: '66000', trips: 5, fareRevenue: 100 },
        { originCounty: '68000', destinationCounty: '68000', trips: 7, fareRevenue: 70 },
      ],
      crossCity: { trips: 7, fareRevenue: 150 },
    });
  });

  it('throws for negative or non-finite input values', () => {
    const flows = new Map<string, CountyFlow>();
    expect(() => addCountyFlow(flows, '6800001', '6600001', -1, 10)).toThrow(RangeError);
    expect(() => addCountyFlow(flows, '6800001', '6600001', 1, Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => scaleCountyFlows(flows, Number.NaN)).toThrow(RangeError);
    expect(() => summarizeCountyFlows([
      { originCounty: '68000', destinationCounty: '66000', trips: 1, fareRevenue: -1 },
    ])).toThrow(RangeError);
  });
});
