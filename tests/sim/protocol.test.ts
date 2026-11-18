import { describe, expect, it, vi } from 'vitest';
import { createEmptyNetwork, type Network } from '../../src/city/network';
import { createSim, snapshotOf } from '../../src/sim/core';
import { LINE_FLOWS_REQUEST_TIMEOUT_MS, SimClient } from '../../src/sim/client';
import {
  isMainToWorkerMessage,
  isTransitErrorMessage,
  isTransitLoadStateMessage,
  isTransitLoadStateResultMessage,
  isTransitLineFlowsMessage,
  isTransitMainToWorkerMessage,
  isTransitPauseMessage,
  isTransitRequestRepresentativePassengerMessage,
  isTransitRequestLineFlowsMessage,
  isTransitRepresentativePassengerResultMessage,
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
  MAX_ID_LENGTH,
  MAX_NETWORK_LINES,
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

const zeroSectionFlow = {
  forward: [{ load: 0, capacity: 0, loadFactor: 0 }],
  backward: [{ load: 0, capacity: 0, loadFactor: 0 }],
};

const zeroStationFlow = {
  forward: { boardings: [0, 0], alightings: [0, 0] },
  backward: { boardings: [0, 0], alightings: [0, 0] },
};

const sectionFlow = {
  morningPeak: zeroSectionFlow,
  offPeak: zeroSectionFlow,
  eveningPeak: zeroSectionFlow,
  night: zeroSectionFlow,
};

const stationFlows = {
  morningPeak: zeroStationFlow,
  offPeak: zeroStationFlow,
  eveningPeak: zeroStationFlow,
  night: zeroStationFlow,
};

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
    sectionFlow,
    stationFlows,
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
  lines: summary.lines.map((line) => {
    const wireLine = { ...line };
    Reflect.deleteProperty(wireLine, 'sectionFlow');
    Reflect.deleteProperty(wireLine, 'stationFlows');
    return wireLine;
  }),
  seq: 0,
  seed: 17,
  trains: [{ id: 'l1-0', lineId: 'l1', lon: 121.5, lat: 25 }],
  recomputeMs: 0,
};

const representativePassenger = {
  selectedStationId: 's1',
  odKey: 'village-a>village-b',
  flow: 12,
  startStationId: 's1',
  endStationId: 's2',
  pathSignature: 'l1:s1>s2:0+',
  legs: [
    { kind: 'walkIn', minutes: 0, toStationId: 's1' },
    { kind: 'wait', minutes: 2, lineId: 'l1', fromStationId: 's1', toStationId: 's1' },
    { kind: 'ride', minutes: 3, lineId: 'l1', fromStationId: 's1', toStationId: 's2', viaStationIds: ['s1', 's2'] },
    { kind: 'walkOut', minutes: 0, fromStationId: 's2' },
  ],
  doorToDoorMinutes: 5,
  alternativeMinutes: 20,
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

const lineFlowsMessage = {
  type: 'lineFlows',
  gameDay: 0,
  periodId: 'morningPeak',
  networkVersion: 1,
  lines: [{ lineId: 'l1', stationCount: 2, sectionFlow, stationFlows }],
};

describe('transit worker protocol guards', () => {
  it.each([
    ['start', isTransitStartMessage, startMessage],
    ['start with multiple village URLs', isTransitStartMessage, {
      ...startMessage,
      villages: { kind: 'urls', urls: ['/villages-a.json', '/villages-b.json'] },
    }],
    ['setNetwork', isTransitSetNetworkMessage, { type: 'setNetwork', network }],
    ['pause', isTransitPauseMessage, { type: 'pause' }],
    ['resume', isTransitResumeMessage, { type: 'resume' }],
    ['setSpeed', isTransitSetSpeedMessage, { type: 'setSpeed', speed: 4 }],
    ['loadState', isTransitLoadStateMessage, { type: 'loadState', requestId: 'load-1', state: saveState }],
    ['saveState', isTransitSaveStateMessage, { type: 'saveState', requestId: 'save-1' }],
    ['request representative passenger', isTransitRequestRepresentativePassengerMessage,
      { type: 'requestRepresentativePassenger', requestId: 'representative-1', stationId: 's1' }],
    ['request all line flows', isTransitRequestLineFlowsMessage,
      { type: 'requestLineFlows', requestId: 'line-flows-1' }],
    ['request one line flow', isTransitRequestLineFlowsMessage,
      { type: 'requestLineFlows', requestId: 'line-flows-2', lineId: 'l1' }],
    ['main-to-worker union', isTransitMainToWorkerMessage, startMessage],
    ['main-to-worker union', isTransitMainToWorkerMessage,
      { type: 'requestLineFlows', requestId: 'line-flows-1' }],
    ['transit snapshot payload', isTransitWorkerSnapshot, transitSnapshot],
    ['snapshot', isTransitSnapshotMessage, { type: 'snapshot', snapshot: transitSnapshot }],
    ['save state', isTransitWorkerSaveState, saveState],
    ['save state result', isTransitSaveStateResultMessage, { type: 'saveStateResult', requestId: 'save-1', state: saveState }],
    ['load state result', isTransitLoadStateResultMessage, { type: 'loadStateResult', requestId: 'load-1', ok: true }],
    ['representative passenger result', isTransitRepresentativePassengerResultMessage,
      { type: 'representativePassengerResult', requestId: 'representative-1', passenger: representativePassenger }],
    ['empty representative passenger result', isTransitRepresentativePassengerResultMessage,
      { type: 'representativePassengerResult', requestId: 'representative-2', passenger: null }],
    ['line flows payload', isTransitLineFlowsMessage, lineFlowsMessage],
    ['line flows response', isTransitWorkerToMainMessage, { ...lineFlowsMessage, requestId: 'line-flows-1' }],
    ['unsolicited line flows', isTransitWorkerToMainMessage, lineFlowsMessage],
    ['error', isTransitErrorMessage, { type: 'error', message: 'worker error', requestId: 'load-1' }],
    ['worker-to-main union', isTransitWorkerToMainMessage, { type: 'snapshot', snapshot: transitSnapshot }],
    ['worker-to-main union', isTransitWorkerToMainMessage,
      { type: 'representativePassengerResult', requestId: 'representative-1', passenger: representativePassenger }],
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
    ['request representative passenger', isTransitRequestRepresentativePassengerMessage,
      { type: 'requestRepresentativePassenger', requestId: 'representative-1', stationId: '' }],
    ['request line flows', isTransitRequestLineFlowsMessage,
      { type: 'requestLineFlows', requestId: 'line-flows-1', lineId: '' }],
    ['main-to-worker union', isTransitMainToWorkerMessage, { type: 'unknown' }],
    ['transit snapshot payload', isTransitWorkerSnapshot, { ...transitSnapshot, seq: -1 }],
    ['snapshot', isTransitSnapshotMessage, { type: 'snapshot', snapshot: undefined }],
    ['save state', isTransitWorkerSaveState, { ...saveState, transit: undefined }],
    ['save state result', isTransitSaveStateResultMessage, { type: 'saveStateResult', requestId: 'save-1' }],
    ['load state result', isTransitLoadStateResultMessage, { type: 'loadStateResult', requestId: 'load-1', ok: false }],
    ['representative passenger result', isTransitRepresentativePassengerResultMessage,
      { type: 'representativePassengerResult', requestId: 'representative-1', passenger: { ...representativePassenger, flow: -1 } }],
    ['line flows payload', isTransitLineFlowsMessage, { ...lineFlowsMessage, networkVersion: -1 }],
    ['error', isTransitErrorMessage, { type: 'error' }],
    ['worker-to-main union', isTransitWorkerToMainMessage, { type: 'unknown' }],
  ])('rejects a malformed %s message', (_name, guard, message) => {
    expect(guard(message)).toBe(false);
  });

  it('validates optional via station IDs only on ride legs', () => {
    const withRide = (ride: unknown) => ({
      ...representativePassenger,
      legs: [...representativePassenger.legs.slice(0, 2), ride, representativePassenger.legs[3]],
    });
    const validRide = representativePassenger.legs[2]!;
    const invalidPassengers = [
      withRide({ ...validRide, viaStationIds: ['s1', 's2', 's3'.repeat(201)] }),
      withRide({ ...validRide, viaStationIds: ['s1', 2] }),
      withRide({ ...validRide, viaStationIds: ['s1'] }),
      withRide({ ...validRide, viaStationIds: Array.from({ length: 201 }, () => 's1') }),
      {
        ...representativePassenger,
        legs: [{ kind: 'walkIn', minutes: 0, toStationId: 's1', viaStationIds: ['s1', 's2'] }, ...representativePassenger.legs.slice(1)],
      },
    ];

    expect(isTransitRepresentativePassengerResultMessage({
      type: 'representativePassengerResult', requestId: 'representative-1', passenger: withRide(validRide),
    })).toBe(true);
    for (const passenger of invalidPassengers) {
      expect(isTransitRepresentativePassengerResultMessage({
        type: 'representativePassengerResult', requestId: 'representative-1', passenger,
      })).toBe(false);
    }
  });

  it('checks line-flow array lengths, ids, and numeric values in both directions', () => {
    const line = lineFlowsMessage.lines[0]!;
    const invalidMessages: unknown[] = [
      { ...lineFlowsMessage, lines: [{ ...line, sectionFlow: { ...sectionFlow, morningPeak: { ...zeroSectionFlow, forward: [] } } }] },
      { ...lineFlowsMessage, lines: [{ ...line, stationFlows: { ...stationFlows, morningPeak: { ...zeroStationFlow, forward: { boardings: [0], alightings: [0, 0] } } } }] },
      { ...lineFlowsMessage, lines: [{ ...line, lineId: 'x'.repeat(MAX_ID_LENGTH + 1) }] },
      { ...lineFlowsMessage, requestId: 'x'.repeat(201) },
      { ...lineFlowsMessage, lines: [{ ...line, sectionFlow: { ...sectionFlow, morningPeak: { ...zeroSectionFlow, forward: [{ load: Number.NaN, capacity: 0, loadFactor: 0 }] } } }] },
      { ...lineFlowsMessage, lines: [{ ...line, stationFlows: { ...stationFlows, morningPeak: { ...zeroStationFlow, forward: { boardings: [0, 0], alightings: [0, Number.NaN] } } } }] },
    ];
    for (const message of invalidMessages) expect(isTransitLineFlowsMessage(message)).toBe(false);

    expect(isTransitRequestLineFlowsMessage({ type: 'requestLineFlows', requestId: 'x'.repeat(201) })).toBe(false);
    expect(isTransitRequestLineFlowsMessage({
      type: 'requestLineFlows', requestId: 'line-flows-1', lineId: 'x'.repeat(MAX_ID_LENGTH + 1),
    })).toBe(false);
  });

  it('uses the shared network line limit for network and line-flow messages', () => {
    const line = lineFlowsMessage.lines[0]!;
    const makeLines = (count: number) => Array.from({ length: count }, (_, index) => ({
      ...line,
      lineId: `line-${index}`,
    }));
    const networkLines = Array.from({ length: MAX_NETWORK_LINES + 1 }, (_, index) => ({
      ...network.lines[0]!,
      id: `line-${index}`,
    }));

    expect(isTransitLineFlowsMessage({ ...lineFlowsMessage, lines: makeLines(501) })).toBe(true);
    expect(isTransitLineFlowsMessage({ ...lineFlowsMessage, lines: makeLines(MAX_NETWORK_LINES + 1) })).toBe(false);
    expect(isTransitSetNetworkMessage({ type: 'setNetwork', network: { ...network, lines: networkLines } })).toBe(false);
  });

  it('allows ids through 200 characters and rejects longer network and flow ids', () => {
    const id200 = 'x'.repeat(MAX_ID_LENGTH);
    const id201 = 'x'.repeat(MAX_ID_LENGTH + 1);
    const [firstStation, secondStation] = network.stations;
    const [firstLine] = network.lines;
    const maxLengthNetwork: Network = {
      ...network,
      stations: [{ ...firstStation!, id: id200 }, secondStation!],
      lines: [{ ...firstLine!, id: id200, stationIds: [id200, secondStation!.id] }],
    };

    expect(isTransitSetNetworkMessage({ type: 'setNetwork', network: maxLengthNetwork })).toBe(true);
    expect(isTransitSetNetworkMessage({
      type: 'setNetwork', network: { ...maxLengthNetwork, stations: [{ ...firstStation!, id: id201 }, secondStation!] },
    })).toBe(false);
    expect(isTransitSetNetworkMessage({
      type: 'setNetwork', network: { ...maxLengthNetwork, lines: [{ ...firstLine!, id: id201 }] },
    })).toBe(false);
    expect(isTransitLineFlowsMessage({
      ...lineFlowsMessage,
      lines: [{ ...lineFlowsMessage.lines[0]!, lineId: id200 }],
    })).toBe(true);
    expect(isTransitLineFlowsMessage({
      ...lineFlowsMessage,
      lines: [{ ...lineFlowsMessage.lines[0]!, lineId: id201 }],
    })).toBe(false);
    expect(isTransitRequestLineFlowsMessage({ type: 'requestLineFlows', requestId: 'r', lineId: 'x'.repeat(81) })).toBe(true);
    expect(isTransitRequestLineFlowsMessage({ type: 'requestLineFlows', requestId: 'r', lineId: id200 })).toBe(true);
    expect(isTransitRequestLineFlowsMessage({ type: 'requestLineFlows', requestId: 'r', lineId: id201 })).toBe(false);
    expect(isTransitRequestRepresentativePassengerMessage({
      type: 'requestRepresentativePassenger', requestId: 'r', stationId: id200,
    })).toBe(true);
    expect(isTransitRequestRepresentativePassengerMessage({
      type: 'requestRepresentativePassenger', requestId: 'r', stationId: id201,
    })).toBe(false);
  });

  it('rejects a line-flow request when the worker does not answer before the timeout', async () => {
    class MinimalWorker {
      static instance: MinimalWorker | undefined;
      readonly messages: unknown[] = [];

      constructor(...args: unknown[]) {
        void args;
        MinimalWorker.instance = this;
      }

      addEventListener(...args: unknown[]): void { void args; }
      removeEventListener(...args: unknown[]): void { void args; }
      postMessage(message: unknown): void { this.messages.push(message); }
      terminate(): void {}
    }

    vi.useFakeTimers();
    vi.stubGlobal('Worker', MinimalWorker);
    const client = new SimClient(undefined, () => 0);
    try {
      client.startTransit(17, { kind: 'data', villages: [...villageSource.villages] }, network);
      const request = client.requestLineFlows('l1');
      const rejection = expect(request).rejects.toThrow('Line-flow request timed out.');

      await vi.advanceTimersByTimeAsync(LINE_FLOWS_REQUEST_TIMEOUT_MS);
      await rejection;
      expect(MinimalWorker.instance?.messages).toContainEqual(expect.objectContaining({
        type: 'requestLineFlows', lineId: 'l1',
      }));
    } finally {
      client.destroy();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
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
      lines: [{ ...transitSnapshot.lines[0]!, sectionFlow, stationFlows }],
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

  it('accepts transit snapshots without line-flow data and rejects them when present', () => {
    expect(isTransitWorkerSnapshot(transitSnapshot)).toBe(true);
    expect(isTransitWorkerSnapshot({
      ...transitSnapshot,
      lines: [{ ...transitSnapshot.lines[0]!, sectionFlow, stationFlows }],
    })).toBe(false);
  });

  it('allows missing county flows and validates them in snapshots and saves', () => {
    const withSnapshotCountyFlows = (countyFlows: unknown) => ({
      ...transitSnapshot,
      city: { ...transitSnapshot.city, countyFlows },
    });
    const withSaveCountyFlows = (countyFlows: unknown) => ({
      ...saveState,
      transit: {
        ...saveState.transit,
        snapshot: { ...summary, city: { ...summary.city, countyFlows } },
      },
    });
    const validCountyFlows = [{ countyCode: '68000', trips: 12, fareRevenue: 34 }];

    expect(isTransitWorkerSnapshot(transitSnapshot)).toBe(true);
    expect(isTransitWorkerSaveState(saveState)).toBe(true);
    expect(isTransitWorkerSnapshot(withSnapshotCountyFlows(validCountyFlows))).toBe(true);
    expect(isTransitWorkerSaveState(withSaveCountyFlows(validCountyFlows))).toBe(true);

    const invalidCountyFlows = [
      [{ countyCode: '6800', trips: 12, fareRevenue: 34 }],
      [{ countyCode: '68000', trips: -1, fareRevenue: 34 }],
      [{ countyCode: '68000', trips: 12, fareRevenue: -1 }],
      Array.from({ length: 65 }, () => ({ countyCode: '68000', trips: 1, fareRevenue: 1 })),
    ];
    for (const countyFlows of invalidCountyFlows) {
      expect(isTransitWorkerSnapshot(withSnapshotCountyFlows(countyFlows))).toBe(false);
      expect(isTransitWorkerSaveState(withSaveCountyFlows(countyFlows))).toBe(false);
    }
  });

  it('validates quality scores and accepts v2 saves whose older snapshots lack them', () => {
    const numericQuality = {
      wait: 80,
      transfer: 70,
      crowding: 60,
      denied: 50,
      total: 66,
      metrics: {
        averageWaitMinutes: 4,
        averageTransfers: 0.3,
        averageLoadFactor: 0.9,
        deniedRatio: 0.02,
      },
    };
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
    delete lines[0]!.sectionFlow;
    delete lines[0]!.stationFlows;
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

  it('accepts one through eight non-empty village URLs', () => {
    for (let count = 1; count <= 8; count += 1) {
      expect(isTransitStartMessage({
        ...startMessage,
        villages: { kind: 'urls', urls: Array.from({ length: count }, (_, index) => `/villages-${index}.json`) },
      })).toBe(true);
    }
  });

  it.each([
    ['zero URLs', []],
    ['nine URLs', Array.from({ length: 9 }, (_, index) => `/villages-${index}.json`)],
    ['an empty URL', ['']],
    ['a URL over 2,000 characters', ['x'.repeat(2_001)]],
  ])('rejects a village URL source with %s', (_name, urls) => {
    expect(isTransitStartMessage({ ...startMessage, villages: { kind: 'urls', urls } })).toBe(false);
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
