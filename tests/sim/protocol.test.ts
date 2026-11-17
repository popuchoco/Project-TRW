import { describe, expect, it } from 'vitest';
import { createEmptyNetwork, type Network } from '../../src/city/network';
import { createSim, snapshotOf } from '../../src/sim/core';
import {
  isMainToWorkerMessage,
  isTransitErrorMessage,
  isTransitLoadStateMessage,
  isTransitLoadStateResultMessage,
  isTransitMainToWorkerMessage,
  isTransitPauseMessage,
  isTransitResumeMessage,
  isTransitSaveStateMessage,
  isTransitSaveStateResultMessage,
  isTransitSetNetworkMessage,
  isTransitSetSpeedMessage,
  isTransitSnapshotMessage,
  isTransitStartMessage,
  isTransitWorkerSnapshot,
  isTransitWorkerSaveState,
  isTransitWorkerToMainMessage,
  isWorkerToMainMessage,
  type TransitWorkerSaveState,
  type TransitWorkerSnapshot,
} from '../../src/sim/protocol';
import type { TransitSummarySnapshot } from '../../src/sim/transit';

const network: Network = {
  stations: [
    { id: 's1', name: 'A', lon: 121.5, lat: 25 },
    { id: 's2', name: 'B', lon: 121.51, lat: 25.01 },
  ],
  lines: [{
    id: 'l1',
    mode: 'metro',
    stationIds: ['s1', 's2'],
    peakTrains: 8,
    offPeakTrains: 4,
    cars: 6,
    color: '#123456',
    name: 'Line 1',
  }],
  nextId: 3,
};

const periodStats = [
  { periodId: 'morningPeak', periodName: '晨峰', maxLoadFactor: 0, operatingCost: 0, roundTripTimeSeconds: 0, headwaySeconds: null, hourlyCapacity: 0, periodCapacity: 0 },
  { periodId: 'offPeak', periodName: '離峰', maxLoadFactor: 0, operatingCost: 0, roundTripTimeSeconds: 0, headwaySeconds: null, hourlyCapacity: 0, periodCapacity: 0 },
  { periodId: 'eveningPeak', periodName: '昏峰', maxLoadFactor: 0, operatingCost: 0, roundTripTimeSeconds: 0, headwaySeconds: null, hourlyCapacity: 0, periodCapacity: 0 },
  { periodId: 'night', periodName: '夜間', maxLoadFactor: 0, operatingCost: 0, roundTripTimeSeconds: 0, headwaySeconds: null, hourlyCapacity: 0, periodCapacity: 0 },
] as const;

const summary: TransitSummarySnapshot = {
  gameTimeMs: 0,
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
    quality: null,
    fareRevenue: 0,
    operatingCost: 0,
    profitLossRatio: 0,
  },
  stations: [{
    stationId: 's1',
    name: 'A',
    entries: 0,
    exits: 0,
    entriesExits: 0,
    peakPlatformWaiting: 0,
    deniedBoardings: 0,
    transfers: 0,
    lineIds: ['l1'],
    last7DaysEntriesExits: [],
  }],
  lines: [{
    lineId: 'l1',
    name: 'Line 1',
    mode: 'metro',
    stationCount: 2,
    lengthKm: 1,
    cars: 6,
    peakTrains: 8,
    offPeakTrains: 4,
    spacingWarnings: [],
    periods: [...periodStats],
    quality: null,
  }],
};

const saveState: TransitWorkerSaveState = {
  version: 2,
  seed: 17,
  transit: {
    version: 1,
    villageFingerprint: '2-1234abcd',
    network,
    gameTimeMs: 0,
    pathRecomputeCount: 0,
    actualAttempts: [],
    snapshot: summary,
  },
};

const transitSnapshot: TransitWorkerSnapshot = {
  ...summary,
  seq: 0,
  seed: 17,
  trains: [{ id: 'l1-0', lineId: 'l1', lon: 121.5, lat: 25 }],
  recomputeMs: 0,
};

const villageSource = {
  kind: 'data',
  villages: [{ VILLCODE: '63000000001', population: 123, demandPoint: [121.5, 25] as [number, number] }],
} as const;

const startMessage = {
  type: 'start',
  seed: 17,
  villages: villageSource,
  network,
  state: saveState,
  paused: true,
  speed: 2 as const,
};

describe('transit worker protocol guards', () => {
  it.each([
    ['start', isTransitStartMessage, startMessage],
    ['setNetwork', isTransitSetNetworkMessage, { type: 'setNetwork', network }],
    ['pause', isTransitPauseMessage, { type: 'pause' }],
    ['resume', isTransitResumeMessage, { type: 'resume' }],
    ['setSpeed', isTransitSetSpeedMessage, { type: 'setSpeed', speed: 4 }],
    ['loadState', isTransitLoadStateMessage, { type: 'loadState', requestId: 'load-1', state: saveState }],
    ['saveState', isTransitSaveStateMessage, { type: 'saveState', requestId: 'save-1' }],
    ['main-to-worker union', isTransitMainToWorkerMessage, startMessage],
    ['transit snapshot payload', isTransitWorkerSnapshot, transitSnapshot],
    ['snapshot', isTransitSnapshotMessage, { type: 'snapshot', snapshot: transitSnapshot }],
    ['save state', isTransitWorkerSaveState, saveState],
    ['save state result', isTransitSaveStateResultMessage, { type: 'saveStateResult', requestId: 'save-1', state: saveState }],
    ['load state result', isTransitLoadStateResultMessage, { type: 'loadStateResult', requestId: 'load-1', ok: true }],
    ['error', isTransitErrorMessage, { type: 'error', message: 'worker error', requestId: 'load-1' }],
    ['worker-to-main union', isTransitWorkerToMainMessage, { type: 'snapshot', snapshot: transitSnapshot }],
  ])('accepts a valid %s message', (_name, guard, message) => {
    expect(guard(message)).toBe(true);
  });

  it.each([
    ['start', isTransitStartMessage, { ...startMessage, villages: undefined }],
    ['setNetwork', isTransitSetNetworkMessage, { type: 'setNetwork', network: undefined }],
    ['pause', isTransitPauseMessage, { type: 'resume' }],
    ['resume', isTransitResumeMessage, { type: 'pause' }],
    ['setSpeed', isTransitSetSpeedMessage, { type: 'setSpeed', speed: 3 }],
    ['loadState', isTransitLoadStateMessage, { type: 'loadState', state: saveState }],
    ['saveState', isTransitSaveStateMessage, { type: 'saveState', requestId: 5 }],
    ['main-to-worker union', isTransitMainToWorkerMessage, { type: 'unknown' }],
    ['transit snapshot payload', isTransitWorkerSnapshot, { ...transitSnapshot, seq: -1 }],
    ['snapshot', isTransitSnapshotMessage, { type: 'snapshot', snapshot: undefined }],
    ['save state', isTransitWorkerSaveState, { ...saveState, transit: undefined }],
    ['save state result', isTransitSaveStateResultMessage, { type: 'saveStateResult', requestId: 'save-1' }],
    ['load state result', isTransitLoadStateResultMessage, { type: 'loadStateResult', requestId: 'load-1', ok: false }],
    ['error', isTransitErrorMessage, { type: 'error' }],
    ['worker-to-main union', isTransitWorkerToMainMessage, { type: 'unknown' }],
  ])('rejects a malformed %s message', (_name, guard, message) => {
    expect(guard(message)).toBe(false);
  });

  it('rejects wrong field types, NaN values, and negative counts at nested levels', () => {
    expect(isTransitStartMessage({ ...startMessage, seed: '17' })).toBe(false);
    expect(isTransitStartMessage({
      ...startMessage,
      villages: { kind: 'data', villages: [{ VILLCODE: 'x', population: -1, demandPoint: [121, 25] }] },
    })).toBe(false);
    expect(isTransitSetSpeedMessage({ type: 'setSpeed', speed: Number.NaN })).toBe(false);
    expect(isTransitSetNetworkMessage({
      type: 'setNetwork',
      network: { ...network, lines: [{ ...network.lines[0], peakTrains: -1 }] },
    })).toBe(false);
    expect(isTransitWorkerSnapshot({ ...transitSnapshot, recomputeMs: Number.NaN })).toBe(false);
    expect(isTransitWorkerSnapshot({
      ...transitSnapshot,
      city: { ...transitSnapshot.city, dailyRidership: Number.NaN },
    })).toBe(false);
    expect(isTransitWorkerSnapshot({
      ...transitSnapshot,
      stations: [{ ...transitSnapshot.stations[0], deniedBoardings: -1 }],
    })).toBe(false);
    expect(isTransitWorkerSnapshot({
      ...transitSnapshot,
      lines: [{ ...transitSnapshot.lines[0], lengthKm: Number.NaN }],
    })).toBe(false);
    expect(isTransitWorkerSnapshot({
      ...transitSnapshot,
      lines: [{ ...transitSnapshot.lines[0], periods: [{ ...periodStats[0], hourlyCapacity: -1 }, ...periodStats.slice(1)] }],
    })).toBe(false);
    expect(isTransitWorkerSaveState({
      ...saveState,
      transit: { ...saveState.transit, actualAttempts: [{ key: 'bad', trips: -1 }] },
    })).toBe(false);
  });

  it('validates quality scores and accepts v2 saves whose older snapshots lack them', () => {
    const numericQuality = { wait: 80, transfer: 70, crowding: 60, denied: 50, total: 66 };
    expect(isTransitWorkerSnapshot({
      ...transitSnapshot,
      city: { ...transitSnapshot.city, quality: numericQuality },
      lines: [{ ...transitSnapshot.lines[0]!, quality: numericQuality }],
    })).toBe(true);
    expect(isTransitWorkerSnapshot({
      ...transitSnapshot,
      city: { ...transitSnapshot.city, quality: { ...numericQuality, total: 100.1 } },
    })).toBe(false);

    const legacy = JSON.parse(JSON.stringify(saveState)) as Record<string, unknown>;
    const transit = legacy.transit as Record<string, unknown>;
    const snapshot = transit.snapshot as Record<string, unknown>;
    const city = snapshot.city as Record<string, unknown>;
    const lines = snapshot.lines as Array<Record<string, unknown>>;
    delete city.quality;
    delete lines[0]!.quality;
    expect(isTransitWorkerSaveState(legacy)).toBe(true);

    const legacySnapshot = JSON.parse(JSON.stringify(transitSnapshot)) as Record<string, unknown>;
    delete (legacySnapshot.city as Record<string, unknown>).quality;
    expect(isTransitWorkerSnapshot(legacySnapshot)).toBe(false);
  });

  it('rejects train counts and car lengths outside the shared limits', () => {
    for (const field of ['peakTrains', 'offPeakTrains'] as const) {
      expect(isTransitSetNetworkMessage({
        type: 'setNetwork',
        network: { ...network, lines: [{ ...network.lines[0]!, [field]: 100_001 }] },
      })).toBe(false);
    }
    expect(isTransitSetNetworkMessage({
      type: 'setNetwork',
      network: { ...network, lines: [{ ...network.lines[0]!, cars: 7 }] },
    })).toBe(false);
    expect(isTransitSetNetworkMessage({
      type: 'setNetwork',
      network: { ...network, lines: [{ ...network.lines[0]!, cars: 2 }] },
    })).toBe(false);
  });

  it('rejects a fractional village population in the kind data source guard', () => {
    expect(isTransitStartMessage({
      ...startMessage,
      villages: { kind: 'data', villages: [{ VILLCODE: 'x', population: 1.5, demandPoint: [121, 25] }] },
    })).toBe(false);
  });

  it('rejects missing transit state and malformed train positions', () => {
    expect(isTransitLoadStateMessage({ type: 'loadState', requestId: 'load-1' })).toBe(false);
    expect(isTransitWorkerSnapshot({
      ...transitSnapshot,
      trains: [{ id: 't1', lineId: 'l1', lon: Number.NaN, lat: 25 }],
    })).toBe(false);
    expect(isTransitWorkerSnapshot({
      ...transitSnapshot,
      trains: [{ id: 't1', lineId: 'l1', lon: 121, lat: -91 }],
    })).toBe(false);
  });
});

describe('legacy P0 worker protocol guards', () => {
  it('continues to accept the existing SimClient messages and snapshots', () => {
    expect(isMainToWorkerMessage({ type: 'start', seed: 7 })).toBe(true);
    expect(isMainToWorkerMessage({ type: 'pause' })).toBe(true);
    expect(isMainToWorkerMessage({ type: 'resume' })).toBe(true);
    expect(isMainToWorkerMessage({ type: 'setSpeed', speed: 4 })).toBe(true);
    expect(isWorkerToMainMessage({ type: 'snapshot', snapshot: snapshotOf(createSim(7)) })).toBe(true);
  });

  it('rejects malformed legacy messages', () => {
    expect(isMainToWorkerMessage({ type: 'start', seed: Number.NaN })).toBe(false);
    expect(isMainToWorkerMessage({ type: 'setSpeed', speed: 3 })).toBe(false);
    expect(isWorkerToMainMessage({
      type: 'snapshot',
      snapshot: { seq: 1, gameTimeMs: 0, entities: [{ id: 'x', lon: Number.NaN, lat: 2 }] },
    })).toBe(false);
  });

  it('rejects the transit start shape in the legacy guard until the worker has transit handling', () => {
    expect(isMainToWorkerMessage(startMessage)).toBe(false);
    expect(isMainToWorkerMessage({ type: 'setNetwork', network: createEmptyNetwork() })).toBe(false);
  });
});
