import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GAME_DAY_MS } from '../../src/city/modes';
import type { Network } from '../../src/city/network';
import {
  binaryLogitShares,
  buildVillageDemandModel,
  TransitSim,
  type TransitPath,
  type VillageDemandPoint,
} from '../../src/sim/transit';
import { getReversePathFromCache } from '../../src/sim/transit/TransitSim';

const TEST_VILLAGES: VillageDemandPoint[] = [
  { code: 'A', population: 50_000, lon: 121.50, lat: 25.03 },
  { code: 'B', population: 50_000, lon: 121.55, lat: 25.03 },
];

function twoStationNetwork(trains: number, mode: 'brt' | 'metro' = 'brt'): Network {
  return {
    nextId: 4,
    stations: [
      { id: 's1', name: 'A站', lon: 121.50, lat: 25.03 },
      { id: 's2', name: 'B站', lon: 121.55, lat: 25.03 },
    ],
    lines: [{
      id: 'l3',
      mode,
      stationIds: ['s1', 's2'],
      peakTrains: trains,
      offPeakTrains: trains,
      cars: mode === 'brt' ? 1 : 3,
      color: '#123456',
      name: 'Test line',
    }],
  };
}

const villageDataPath = resolve(process.cwd(), 'public/data/villages-6300065000.json');
const realVillages = JSON.parse(readFileSync(villageDataPath, 'utf8')) as Array<{
  VILLCODE: string;
  population: number;
  demandPoint: [number, number];
}>;

function makeScenarioNetwork(villages: typeof realVillages): Network {
  const targets: Array<readonly [number, number]> = [
    [121.505, 25.028], [121.517, 25.035], [121.529, 25.042], [121.541, 25.047], [121.553, 25.050],
    [121.565, 25.052], [121.577, 25.053], [121.589, 25.056], [121.601, 25.060], [121.613, 25.064],
  ];
  const used = new Set<string>();
  const stations = targets.map((target, index) => {
    let nearest = villages[0]!;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const village of villages) {
      if (used.has(village.VILLCODE)) continue;
      const dx = village.demandPoint[0] - target[0];
      const dy = village.demandPoint[1] - target[1];
      const distance = dx * dx + dy * dy;
      if (distance < nearestDistance || (distance === nearestDistance && village.VILLCODE < nearest.VILLCODE)) {
        nearest = village;
        nearestDistance = distance;
      }
    }
    used.add(nearest.VILLCODE);
    return {
      id: `s${index + 1}`,
      name: `${nearest.VILLCODE}站`,
      lon: nearest.demandPoint[0],
      lat: nearest.demandPoint[1],
    };
  });
  return {
    stations,
    lines: [{
      id: 'l11', mode: 'metro', stationIds: stations.map(({ id }) => id),
      peakTrains: 20, offPeakTrains: 10, cars: 6, color: '#d22', name: '情境捷運線',
    }],
    nextId: 12,
  };
}

describe('gravity demand and transit choice', () => {
  it('uses a spatial grid, ignores zero-population villages and respects the distance cap', () => {
    const model = buildVillageDemandModel([
      ...TEST_VILLAGES,
      { code: 'C', population: 0, lon: 121.51, lat: 25.03 },
      { code: 'D', population: 1_000, lon: 122.2, lat: 25.03 },
    ], { dailyTripsPerPerson: 0.2 });
    expect(model.pairs).toHaveLength(1);
    expect(model.pairs[0]?.distanceKm).toBeLessThan(25);
    expect(model.totalDailyTrips).toBe(20_000);
  });

  it('allocates binary logit shares that sum to one', () => {
    const shares = binaryLogitShares(900, 1_200, 300);
    expect(shares.transit + shares.alternative).toBeCloseTo(1, 12);
    expect(binaryLogitShares(null, 600)).toEqual({ transit: 0, alternative: 1 });
  });
});

describe('period-group reverse paths', () => {
  it('keeps the same path time separately for peak and off-peak groups', () => {
    const peakPath: TransitPath = {
      startStationId: 's1',
      endStationId: 's2',
      timeSeconds: 420,
      legs: [{
        lineId: 'l1', fromStationId: 's1', toStationId: 's2',
        segments: [{ lineId: 'l1', segmentIndex: 0, direction: 1 }],
      }],
      transfers: 0,
      signature: 'l1:s1>s2:0+',
    };
    const offPeakPath = { ...peakPath, timeSeconds: 780 };
    const peakReversePaths = new Map<string, TransitPath>();
    const offPeakReversePaths = new Map<string, TransitPath>();

    const reversePeak = getReversePathFromCache(peakPath, peakReversePaths);
    const reverseOffPeak = getReversePathFromCache(offPeakPath, offPeakReversePaths);

    expect(reversePeak.timeSeconds).toBe(420);
    expect(reverseOffPeak.timeSeconds).toBe(780);
    expect(peakReversePaths.size).toBe(1);
    expect(offPeakReversePaths.size).toBe(1);
  });
});

describe('TransitSim behavior', () => {
  it('does not recompute paths on steps without a network change', () => {
    const sim = new TransitSim(TEST_VILLAGES);
    sim.setNetwork(twoStationNetwork(5));
    sim.advance(0);
    expect(sim.pathRecomputeCount).toBe(1);
    sim.advance(1_000);
    sim.advance(1_000);
    expect(sim.pathRecomputeCount).toBe(1);
    sim.setNetwork(twoStationNetwork(4));
    sim.advance(0);
    expect(sim.pathRecomputeCount).toBe(2);
  });

  it('produces identical stats for identical data, network and game-time steps', () => {
    const first = new TransitSim(TEST_VILLAGES, twoStationNetwork(20));
    const second = new TransitSim(TEST_VILLAGES, twoStationNetwork(20));
    expect(first.advance(GAME_DAY_MS * 4)).toEqual(second.advance(GAME_DAY_MS * 4));
  });

  it('keeps zero-train service snapshots JSON-serializable', () => {
    const result = new TransitSim(TEST_VILLAGES, twoStationNetwork(0)).advance(GAME_DAY_MS);
    expect(result.city.potentialTrips).toBeGreaterThan(0);
    expect(result.city.dailyRidership).toBe(0);
    expect(result.lines[0]?.periods.every(({ headwaySeconds }) => headwaySeconds === null)).toBe(true);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('summarizes accepted county-pair trips and fare revenue in stable order', () => {
    const villages: VillageDemandPoint[] = [
      { code: '63000123456', population: 50_000, lon: 121.50, lat: 25.03 },
      { code: '68000123456', population: 50_000, lon: 121.55, lat: 25.03 },
      { code: '63000654321', population: 50_000, lon: 121.525, lat: 25.03 },
    ];
    const network: Network = {
      nextId: 5,
      stations: [
        { id: 's1', name: '臺北端', lon: 121.50, lat: 25.03 },
        { id: 's2', name: '中間站', lon: 121.525, lat: 25.03 },
        { id: 's3', name: '桃園端', lon: 121.55, lat: 25.03 },
      ],
      lines: [{
        id: 'l4', mode: 'brt', stationIds: ['s1', 's2', 's3'],
        peakTrains: 1_000, offPeakTrains: 1_000, cars: 1, color: '#123456', name: '跨縣市線',
      }],
    };
    const result = new TransitSim(villages, network).advance(GAME_DAY_MS);
    const flows = result.city.countyFlows!;
    const tripsTotal = flows.reduce((total, flow) => total + flow.trips, 0);
    const fareTotal = flows.reduce((total, flow) => total + flow.fareRevenue, 0);
    const relativeError = (actual: number, expected: number): number =>
      Math.abs(actual - expected) / Math.max(Math.abs(expected), Number.EPSILON);

    expect(relativeError(tripsTotal, result.city.dailyRidership)).toBeLessThanOrEqual(1e-9);
    expect(relativeError(fareTotal, result.city.fareRevenue)).toBeLessThanOrEqual(1e-9);
    expect(flows.filter((flow) => flow.originCounty !== flow.destinationCounty)
      .reduce((total, flow) => total + flow.trips, 0)).toBeGreaterThan(0);
    expect(flows.some((flow) => flow.originCounty === '63000' && flow.destinationCounty === '63000'))
      .toBe(true);
    expect(flows.map(({ originCounty, destinationCounty }) => `${originCounty}>${destinationCounty}`))
      .toEqual(flows.map(({ originCounty, destinationCounty }) => `${originCounty}>${destinationCounty}`).sort());
  });

  it('scales overloaded segment flow to capacity and records denied boardings', () => {
    const sim = new TransitSim(TEST_VILLAGES, twoStationNetwork(1));
    let result = sim.snapshot();
    for (let day = 0; day < 7; day += 1) result = sim.advance(GAME_DAY_MS);
    const line = result.lines[0]!;
    expect(result.city.deniedBoardings).toBeGreaterThan(0);
    expect(line.periods.every(({ maxLoadFactor }) => maxLoadFactor <= 1 + 1e-10)).toBe(true);
    expect(result.city.dailyRidership).toBeGreaterThan(0);
  });

  it('scores each journey by its most crowded segment', () => {
    const network: Network = {
      nextId: 4,
      stations: [
        { id: 's1', name: '甲站', lon: 121.50, lat: 25.03 },
        { id: 's2', name: '乙站', lon: 121.53, lat: 25.03 },
        { id: 's3', name: '丙站', lon: 121.56, lat: 25.03 },
      ],
      lines: [{
        id: 'l4', mode: 'brt', stationIds: ['s1', 's2', 's3'],
        peakTrains: 100, offPeakTrains: 100, cars: 1, color: '#123456', name: '三站線',
      }],
    };
    const villages: VillageDemandPoint[] = [
      { code: 'A', population: 100_000, lon: 121.50, lat: 25.03 },
      { code: 'B', population: 20_000, lon: 121.53, lat: 25.03 },
      { code: 'C', population: 5_000, lon: 121.56, lat: 25.03 },
    ];
    const result = new TransitSim(villages, network).advance(GAME_DAY_MS);
    const line = result.lines[0]!;
    let segmentWeightedLoadFactor = 0;
    let segmentPassengers = 0;
    for (const flow of Object.values(line.sectionFlow)) {
      for (const direction of [flow.forward, flow.backward]) {
        for (const segment of direction) {
          segmentWeightedLoadFactor += segment.load * segment.loadFactor;
          segmentPassengers += segment.load;
        }
      }
    }

    expect(result.city.quality?.metrics?.averageLoadFactor).toBeGreaterThan(
      segmentWeightedLoadFactor / segmentPassengers,
    );
  });

  it('approaches equilibrium ridership monotonically with the seven-day habit curve', () => {
    const sim = new TransitSim(TEST_VILLAGES, twoStationNetwork(1_000));
    const daily = [];
    for (let day = 0; day < 7; day += 1) daily.push(sim.advance(GAME_DAY_MS).city.dailyRidership);
    for (let day = 1; day < daily.length; day += 1) {
      expect(daily[day]).toBeGreaterThanOrEqual(daily[day - 1]!);
    }
    const habitFraction = 1 - Math.exp(-1 / 7);
    expect(daily[0]).toBeGreaterThan(0);
    expect(daily[1]! / daily[0]!).toBeCloseTo(2 - habitFraction, 4);
  });

  it('continues identically after a JSON worker-state restart', () => {
    const uninterrupted = new TransitSim(TEST_VILLAGES, twoStationNetwork(30));
    uninterrupted.advance(GAME_DAY_MS * 3);
    const saved = JSON.parse(JSON.stringify(uninterrupted.serialize())) as ReturnType<typeof uninterrupted.serialize>;
    const restarted = TransitSim.restore(TEST_VILLAGES, saved);
    const uninterruptedNext = uninterrupted.advance(GAME_DAY_MS * 2);
    const restartedNext = restarted.advance(GAME_DAY_MS * 2);
    expect(restartedNext).toEqual(uninterruptedNext);
  });

  it('counts transfers at shared stations between BRT and metro lines', () => {
    const transferNetwork: Network = {
      nextId: 7,
      stations: [
        { id: 's1', name: '起點', lon: 121.50, lat: 25.03 },
        { id: 's2', name: '轉乘', lon: 121.525, lat: 25.03 },
        { id: 's3', name: '終點', lon: 121.55, lat: 25.03 },
      ],
      lines: [
        { id: 'l4', mode: 'brt', stationIds: ['s1', 's2'], peakTrains: 500, offPeakTrains: 500, cars: 1, color: '#b22', name: 'BRT' },
        { id: 'l5', mode: 'metro', stationIds: ['s2', 's3'], peakTrains: 500, offPeakTrains: 500, cars: 3, color: '#22b', name: 'Metro' },
      ],
    };
    const villages = [
      { code: 'A', population: 50_000, lon: 121.50, lat: 25.03 },
      { code: 'B', population: 50_000, lon: 121.55, lat: 25.03 },
    ];
    const result = new TransitSim(villages, transferNetwork).advance(GAME_DAY_MS);
    expect(result.city.transfers).toBeGreaterThan(0);
    expect(result.stations.find(({ stationId }) => stationId === 's2')?.transfers).toBeGreaterThan(0);
  });

  it('uses the committed Taipei/New Taipei data for a seven-day metro scenario', () => {
    const villages: VillageDemandPoint[] = realVillages.map((village) => ({
      code: village.VILLCODE,
      population: village.population,
      lon: village.demandPoint[0],
      lat: village.demandPoint[1],
    }));
    const network = makeScenarioNetwork(realVillages);
    const sim = new TransitSim(villages, network);
    const dailyRidership: number[] = [];
    let result = sim.snapshot();
    for (let day = 0; day < 7; day += 1) {
      result = sim.advance(GAME_DAY_MS);
      dailyRidership.push(result.city.dailyRidership);
    }
    expect(result.city.dailyRidership).toBeGreaterThan(0);
    for (let day = 1; day < dailyRidership.length; day += 1) {
      expect(dailyRidership[day]).toBeGreaterThanOrEqual(dailyRidership[day - 1]!);
    }
    sim.setNetwork({
      ...sim.network,
      lines: sim.network.lines.map((line) => ({ ...line, peakTrains: 1, offPeakTrains: 1 })),
    });
    result = sim.advance(GAME_DAY_MS);
    expect(result.city.deniedBoardings).toBeGreaterThan(0);
  });
});

