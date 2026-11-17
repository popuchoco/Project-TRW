import { describe, expect, it } from 'vitest';
import type { Network } from '../../src/city/network';
import { GAME_DAY_MS, SIMULATION_BALANCE } from '../../src/city/modes';
import { TransitSim } from '../../src/sim/transit/TransitSim';
import type { VillageDemandPoint } from '../../src/sim/transit/demand';

const network: Network = {
  stations: [
    { id: 's1', name: '甲', lon: 121.5, lat: 25 },
    { id: 's2', name: '乙', lon: 121.51, lat: 25 },
    { id: 's3', name: '丙', lon: 121.52, lat: 25 },
  ],
  lines: [{
    id: 'l1',
    name: '測試線',
    mode: 'metro',
    stationIds: ['s1', 's2', 's3'],
    peakTrains: 8,
    offPeakTrains: 4,
    cars: 3,
    color: '#123456',
  }],
  nextId: 5,
};

const villages: VillageDemandPoint[] = [
  { code: 'v1', population: 1_000, lon: 121.5, lat: 25 },
  { code: 'v2', population: 1_000, lon: 121.52, lat: 25 },
];

function runOneDay() {
  return new TransitSim(villages, network).advance(GAME_DAY_MS);
}

describe('daily section flow', () => {
  it('has stationCount − 1 sections in both directions for every period', () => {
    const snapshot = runOneDay();

    for (const line of snapshot.lines) {
      for (const { id } of SIMULATION_BALANCE.periods) {
        expect(line.sectionFlow[id].forward).toHaveLength(line.stationCount - 1);
        expect(line.sectionFlow[id].backward).toHaveLength(line.stationCount - 1);
      }
    }
    expect(snapshot.lines[0]!.sectionFlow.morningPeak.forward.some(({ load }) => load > 0)
      || snapshot.lines[0]!.sectionFlow.morningPeak.backward.some(({ load }) => load > 0)).toBe(true);
  });

  it('conserves directional riders from station boardings and alightings to each section load', () => {
    const snapshot = runOneDay();

    for (const line of snapshot.lines) {
      for (const period of SIMULATION_BALANCE.periods) {
        for (const direction of ['forward', 'backward'] as const) {
          const stationFlow = line.stationFlows[period.id][direction];
          const sections = line.sectionFlow[period.id][direction];
          let aboard = 0;
          const stationIndexes = direction === 'forward'
            ? Array.from({ length: line.stationCount - 1 }, (_, index) => index)
            : Array.from({ length: line.stationCount - 1 }, (_, index) => line.stationCount - 1 - index);

          for (const stationIndex of stationIndexes) {
            aboard += stationFlow.boardings[stationIndex]! - stationFlow.alightings[stationIndex]!;
            const sectionIndex = direction === 'forward' ? stationIndex : stationIndex - 1;
            expect(sections[sectionIndex]!.load).toBeCloseTo(aboard, 8);
          }
        }
      }
    }
  });

  it('produces identical flow data for identical runs', () => {
    const first = runOneDay();
    const second = runOneDay();

    for (const lineIndex of first.lines.keys()) {
      expect(first.lines[lineIndex]!.sectionFlow).toEqual(second.lines[lineIndex]!.sectionFlow);
      expect(first.lines[lineIndex]!.stationFlows).toEqual(second.lines[lineIndex]!.stationFlows);
    }
  });
});
