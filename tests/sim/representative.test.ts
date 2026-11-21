import { describe, expect, it } from 'vitest';
import { buildTransitGraph, shortestStationPath } from '../../src/sim/transit/graph';
import { buildRepresentativeTripPath, representativeStationIds } from '../../src/sim/transit/representative';
import { TransitWorkerRuntime } from '../../src/sim/worker-runtime';
import { selectRepresentativeTrip, tripLegs, type RepresentativeTripRoute } from '../../src/sim/transit/representative';

const network = {
  stations: [
    { id: 's1', name: '甲站', lon: 121.5, lat: 25 },
    { id: 's2', name: '乙站', lon: 121.51, lat: 25 },
  ],
  lines: [{
    id: 'l3', mode: 'brt' as const, stationIds: ['s1', 's2'], peakTrains: 8, offPeakTrains: 4,
    cars: 1, color: '#123456', name: 'BRT',
  }],
  nextId: 4,
};

const demandVillages = [
  { code: 'village-a', population: 1_000, lon: 121.5, lat: 25.001 },
  { code: 'village-b', population: 1_000, lon: 121.51, lat: 25.001 },
];

function route(odKey: string, flow: number, stationIds = ['s1', 's2']): RepresentativeTripRoute {
  return {
    odKey,
    flow,
    periodId: 'morningPeak',
    path: {
      transitPath: {
        startStationId: 's1',
        endStationId: 's2',
        timeSeconds: 600,
        legs: [{
          lineId: 'l1',
          fromStationId: 's1',
          toStationId: 's2',
          segments: [{ lineId: 'l1', segmentIndex: 0, direction: 1 }],
        }],
        transfers: 0,
        signature: `${odKey}-path`,
      },
      stationIds,
      rideStationIds: [['s1', 's2']],
      walkInSeconds: 30,
      waitSeconds: [60],
      rideSeconds: [540],
      transferSeconds: [],
      walkOutSeconds: 90,
      alternativeSeconds: 1_200,
    },
  };
}

describe('representative passenger selection', () => {
  it('selects the same maximum-flow route and breaks ties with compareText on the OD key', () => {
    const routes = [route('village-z>village-a', 10), route('village-b>village-c', 10), route('village-q>village-p', 4)];
    const first = selectRepresentativeTrip(routes, 's1');
    const second = selectRepresentativeTrip(routes, 's1');

    expect(first).toEqual(second);
    expect(first?.odKey).toBe('village-b>village-c');
  });

  it('returns null when no equilibrium route passes the selected station', () => {
    expect(selectRepresentativeTrip([route('village-a>village-b', 10)], 's9')).toBeNull();
  });

  it('decomposes the door-to-door path into legs with the same total time', () => {
    const selected = selectRepresentativeTrip([route('village-a>village-b', 10)], 's1');
    expect(selected).not.toBeNull();
    const minutes = tripLegs(route('village-a>village-b', 10).path).reduce((total, leg) => total + leg.minutes, 0);

    expect(minutes).toBeCloseTo(selected!.doorToDoorMinutes, 10);
    expect(selected!.doorToDoorMinutes).toBe(12);
    expect(selected!.alternativeMinutes).toBe(20);
  });

  it('includes ordered stations for a multi-station ride leg', () => {
    const threeStationNetwork = {
      ...network,
      stations: [
        ...network.stations,
        { id: 's3', name: '丙站', lon: 121.52, lat: 25 },
      ],
      lines: [{ ...network.lines[0]!, stationIds: ['s1', 's2', 's3'] }],
      nextId: 5,
    };
    const graph = buildTransitGraph(threeStationNetwork);
    const transitPath = shortestStationPath(graph, 'morningPeak', 's1', 's3');
    expect(transitPath).not.toBeNull();

    const path = buildRepresentativeTripPath(transitPath!, graph, 'morningPeak', 30, 90, 1_200);
    const ride = tripLegs(path).find((leg) => leg.kind === 'ride');

    expect(ride?.viaStationIds).toEqual(['s1', 's2', 's3']);
    expect(ride?.viaStationIds?.[0]).toBe(ride?.fromStationId);
    expect(ride?.viaStationIds?.at(-1)).toBe(ride?.toStationId);
    expect(tripLegs(path).reduce((total, leg) => total + leg.minutes, 0))
      .toBeCloseTo((30 + transitPath!.timeSeconds + 90) / 60, 10);
  });

  it('returns the same representative stations for repeated path signatures', () => {
    const graph = buildTransitGraph(network);
    const firstPath = shortestStationPath(graph, 'morningPeak', 's1', 's2');
    const repeatedPath = shortestStationPath(graph, 'morningPeak', 's1', 's2');
    expect(firstPath).not.toBeNull();
    expect(repeatedPath).not.toBeNull();
    expect(repeatedPath!.signature).toBe(firstPath!.signature);

    expect(representativeStationIds(repeatedPath!, graph)).toEqual(representativeStationIds(firstPath!, graph));
  });

  it('returns representative trip data on demand from the worker runtime', async () => {
    const runtime = new TransitWorkerRuntime(async () => demandVillages);
    await runtime.handle({
      type: 'start',
      seed: 1,
      villages: { kind: 'data', villages: [] },
      network,
      paused: true,
    });

    const outputs = await runtime.handle({
      type: 'requestRepresentativePassenger',
      requestId: 'representative-1',
      stationId: 's1',
    });
    const result = outputs[0];
    expect(result?.type).toBe('representativePassengerResult');
    if (result?.type !== 'representativePassengerResult') throw new Error('Worker returned no representative passenger result.');
    expect(result.passenger).not.toBeNull();
    const legMinutes = result.passenger!.legs.reduce((total, leg) => total + leg.minutes, 0);
    expect(legMinutes).toBeCloseTo(result.passenger!.doorToDoorMinutes, 10);
    expect(result.passenger!.alternativeMinutes).not.toBeNull();
  });
});
