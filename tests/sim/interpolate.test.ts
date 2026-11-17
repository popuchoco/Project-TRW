import { describe, expect, it } from 'vitest';
import { interpolateTrainSnapshots } from '../../src/sim/interpolate';
import type { TransitWorkerSnapshot } from '../../src/sim/protocol';

function snapshot(gameTimeMs: number, trains: TransitWorkerSnapshot['trains']): TransitWorkerSnapshot {
  return {
    seq: gameTimeMs / 100,
    seed: 3,
    gameTimeMs,
    gameDay: 0,
    currentPeriodId: 'morningPeak',
    pathRecomputeCount: 0,
    demandPairCount: 0,
    city: {
      gameDay: 0,
      dailyRidership: 0,
      potentialTrips: 0,
      transitShare: 0,
      deniedBoardings: 0,
      transfers: 0,
      fareRevenue: 0,
      operatingCost: 0,
      profitLossRatio: 0,
    },
    stations: [],
    lines: [],
    trains,
    recomputeMs: 0,
  };
}

describe('train snapshot interpolation', () => {
  const previous = snapshot(100, [{ id: 't1', lineId: 'l1', lon: 120, lat: 23 }]);
  const next = snapshot(200, [
    { id: 't1', lineId: 'l1', lon: 122, lat: 25 },
    { id: 't2', lineId: 'l1', lon: 123, lat: 26 },
  ]);

  it('interpolates matching train positions and preserves newly visible trains', () => {
    expect(interpolateTrainSnapshots(previous, next, 150)).toEqual([
      { id: 't1', lineId: 'l1', lon: 121, lat: 24 },
      { id: 't2', lineId: 'l1', lon: 123, lat: 26 },
    ]);
  });

  it.each([
    [0, 120, 23],
    [100, 120, 23],
    [200, 122, 25],
    [500, 122, 25],
  ])('clamps interpolation at game time %i', (time, lon, lat) => {
    expect(interpolateTrainSnapshots(previous, next, time)[0]).toEqual({ id: 't1', lineId: 'l1', lon, lat });
  });

  it('uses the next snapshot when no previous train position exists', () => {
    expect(interpolateTrainSnapshots(snapshot(100, []), next, 150)).toEqual(next.trains);
  });
});
