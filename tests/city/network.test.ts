import { describe, expect, it } from 'vitest';
import {
  addLine,
  addStation,
  createEmptyNetwork,
  lineHeadwaySeconds,
  lineHourlyCapacity,
  lineLengthKm,
  lineRoundTripTimeSeconds,
  lineSpacingWarnings,
} from '../../src/city/network';
import { TRANSIT_MODES } from '../../src/city/modes';

describe('transit mode balance values', () => {
  it('defines initial BRT and metro capacity, speed and station spacing', () => {
    expect(TRANSIT_MODES.brt).toMatchObject({
      carsFixed: 1,
      capacityPerCar: 120,
      avgSpeedKmh: 22,
      recommendedSpacingKm: [0.4, 0.8],
    });
    expect(TRANSIT_MODES.metro).toMatchObject({
      carsMin: 3,
      carsMax: 6,
      capacityPerCar: 330,
      avgSpeedKmh: 38,
      recommendedSpacingKm: [0.8, 1.5],
    });
  });
});

describe('city network helpers', () => {
  it('creates deterministic counter-based IDs', () => {
    let network = createEmptyNetwork();
    const first = addStation(network, { name: 'A', lon: 121, lat: 25 });
    network = first.network;
    const second = addStation(network, { name: 'B', lon: 121.01, lat: 25 });
    network = second.network;
    const line = addLine(network, {
      mode: 'brt',
      stationIds: [first.station.id, second.station.id],
      peakTrains: 2,
      offPeakTrains: 1,
      cars: 1,
      color: '#ff0000',
      name: 'Line 1',
    });
    expect([first.station.id, second.station.id, line.line.id]).toEqual(['s1', 's2', 'l3']);
    expect(line.network.nextId).toBe(4);
  });

  it('calculates round trip, headway and hourly capacity from line length', () => {
    const stations = [
      { id: 's1', name: 'A', lon: 121, lat: 25 },
      { id: 's2', name: 'B', lon: 121.01, lat: 25 },
    ];
    const line = {
      id: 'l1', mode: 'brt' as const, stationIds: ['s1', 's2'],
      peakTrains: 2, offPeakTrains: 1, cars: 1, color: '#f00', name: 'Test',
    };
    const lengthKm = lineLengthKm(line, stations);
    const expectedRoundTrip = 2 * (lengthKm / TRANSIT_MODES.brt.avgSpeedKmh * 3_600 + 2 * TRANSIT_MODES.brt.dwellSecondsPerStop);
    const headway = expectedRoundTrip / line.peakTrains;
    expect(lineRoundTripTimeSeconds(line, stations)).toBeCloseTo(expectedRoundTrip, 8);
    expect(lineHeadwaySeconds(line, stations, 'morningPeak')).toBeCloseTo(headway, 8);
    expect(lineHourlyCapacity(line, stations, 'morningPeak')).toBeCloseTo((3_600 / headway) * 120, 8);
  });

  it('reports out-of-range spacing without rejecting a line', () => {
    const stations = [
      { id: 's1', name: 'A', lon: 121, lat: 25 },
      { id: 's2', name: 'B', lon: 121.001, lat: 25 },
    ];
    const line = {
      id: 'l1', mode: 'metro' as const, stationIds: ['s1', 's2'],
      peakTrains: 4, offPeakTrains: 2, cars: 3, color: '#f00', name: 'Test',
    };
    expect(lineSpacingWarnings(line, stations)).toHaveLength(1);
  });
});

