import { describe, expect, it } from 'vitest';
import {
  addIndexedCountyFlow,
  addCountyFlow,
  countyOfVillage,
  scaleCountyFlows,
  summarizeCountyFlows,
  type CountyFlow,
} from '../../src/sim/transit/cross-city';

describe('cross-city county flows', () => {
  it('accumulates indexed county pairs without string keys', () => {
    const flows = new Map<number, { trips: number; fareRevenue: number }>();
    addIndexedCountyFlow(flows, 7, 0.1, 1);
    addIndexedCountyFlow(flows, 7, 0.2, 2);
    addIndexedCountyFlow(flows, 3, 4, 5);

    expect([...flows.entries()]).toEqual([
      [7, { trips: 0.30000000000000004, fareRevenue: 3 }],
      [3, { trips: 4, fareRevenue: 5 }],
    ]);
    expect(() => addIndexedCountyFlow(flows, -1, 1, 1)).toThrow(RangeError);
  });

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

  it('keeps one entry per county pair and never aliases accumulator entries in outputs', () => {
    const flows = new Map<string, CountyFlow>();
    for (let i = 0; i < 1_000; i += 1) addCountyFlow(flows, '6800001', '6300001', 0.5, 10);
    expect(flows.size).toBe(1);
    expect([...flows.values()][0]).toEqual({ originCounty: '68000', destinationCounty: '63000', trips: 500, fareRevenue: 10_000 });

    const scaled = scaleCountyFlows(flows, 1);
    const summary = summarizeCountyFlows([...flows.values()]);
    addCountyFlow(flows, '6800001', '6300001', 1, 1);
    expect(scaled[0]!.trips).toBe(500);
    expect(summary.flows[0]!.trips).toBe(500);
    expect([...flows.values()][0]!.trips).toBe(501);
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
