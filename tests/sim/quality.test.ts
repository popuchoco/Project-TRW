import { describe, expect, it } from 'vitest';
import { GAME_DAY_MS } from '../../src/city/modes';
import type { Network } from '../../src/city/network';
import { TransitSim, type TransitSimSerializedState } from '../../src/sim/transit';
import {
  calculateQualityScore,
  scoreCrowding,
  scoreDenied,
  scoreTransfers,
  scoreWait,
} from '../../src/sim/transit/quality';

describe('transit quality score formulas', () => {
  it('scores wait boundaries in minutes', () => {
    expect(scoreWait(2)).toBe(100);
    expect(scoreWait(10)).toBe(0);
    expect(scoreWait(6)).toBe(50);
  });

  it('scores transfer boundaries per passenger', () => {
    expect(scoreTransfers(0)).toBe(100);
    expect(scoreTransfers(1)).toBe(0);
    expect(scoreTransfers(1.5)).toBe(0);
  });

  it('scores crowding boundaries and the midpoint', () => {
    expect(scoreCrowding(0.8)).toBe(100);
    expect(scoreCrowding(1.0)).toBe(50);
    expect(scoreCrowding(1.2)).toBe(0);
  });

  it('scores denied boarding boundaries', () => {
    expect(scoreDenied(0)).toBe(100);
    expect(scoreDenied(0.1)).toBe(0);
    expect(scoreDenied(0.15)).toBe(0);
  });

  it('combines the subscores with the specified weights', () => {
    expect(calculateQualityScore({
      passengerCount: 10,
      averageWaitMinutes: 6,
      averageTransfers: 0.25,
      averageLoadFactor: 1,
      deniedRatio: 0.05,
    })).toEqual({ wait: 50, transfer: 75, crowding: 50, denied: 50, total: 55 });
  });

  it('returns null for an empty passenger set and is deterministic', () => {
    expect(calculateQualityScore({
      passengerCount: 0,
      averageWaitMinutes: 0,
      averageTransfers: 0,
      averageLoadFactor: 0,
      deniedRatio: 0,
    })).toBeNull();

    const metrics = {
      passengerCount: 10,
      averageWaitMinutes: 4.5,
      averageTransfers: 0.2,
      averageLoadFactor: 0.9,
      deniedRatio: 0.03,
    };
    expect(calculateQualityScore(metrics)).toEqual(calculateQualityScore(metrics));
  });

  it('restores older saved daily stats with null quality values', () => {
    const network: Network = {
      nextId: 3,
      stations: [
        { id: 's1', name: '甲站', lon: 121.5, lat: 25 },
        { id: 's2', name: '乙站', lon: 121.51, lat: 25 },
      ],
      lines: [{
        id: 'l1',
        mode: 'metro',
        stationIds: ['s1', 's2'],
        peakTrains: 1,
        offPeakTrains: 1,
        cars: 3,
        color: '#123456',
        name: '測試線',
      }],
    };
    const current = new TransitSim([], network);
    current.advance(GAME_DAY_MS);
    const legacy = JSON.parse(JSON.stringify(current.serialize())) as Record<string, unknown>;
    const snapshot = (legacy as { snapshot: Record<string, unknown> }).snapshot;
    delete (snapshot.city as Record<string, unknown>).quality;
    for (const line of snapshot.lines as Array<Record<string, unknown>>) delete line.quality;

    const restored = TransitSim.restore([], legacy as unknown as TransitSimSerializedState).snapshot();
    expect(restored.city.quality).toBeNull();
    expect(restored.lines[0]?.quality).toBeNull();
  });

  it('records denied boardings with one train assigned to every period', () => {
    const network: Network = {
      nextId: 3,
      stations: [
        { id: 's1', name: '甲站', lon: 121.5, lat: 25 },
        { id: 's2', name: '乙站', lon: 121.51, lat: 25 },
      ],
      lines: [{
        id: 'l1',
        mode: 'metro',
        stationIds: ['s1', 's2'],
        peakTrains: 1,
        offPeakTrains: 1,
        cars: 3,
        color: '#123456',
        name: '測試線',
      }],
    };
    const simulation = new TransitSim([
      { code: 'v1', population: 1_000_000, lon: 121.5, lat: 25 },
      { code: 'v2', population: 1_000_000, lon: 121.51, lat: 25 },
    ], network);

    const snapshot = simulation.advance(2 * GAME_DAY_MS);
    expect(snapshot.city.quality).not.toBeNull();
    expect(snapshot.city.quality!.denied).toBeLessThan(100);
    expect(snapshot.lines[0]?.quality?.denied).toBeLessThan(100);
  });
});
