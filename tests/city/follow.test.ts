import { describe, expect, it } from 'vitest';
import {
  followCameraTarget,
  followReducer,
  passengerPositionAt,
  type FollowState,
} from '../../src/city/follow';
import type { RepresentativePassenger } from '../../src/sim/transit/representative';

const idle: FollowState = { kind: 'idle' };
const passenger: RepresentativePassenger = {
  selectedStationId: 's1',
  odKey: 's1>s3',
  flow: 1,
  startStationId: 's1',
  endStationId: 's3',
  pathSignature: 'l1:s1>s3',
  legs: [
    { kind: 'walkIn', minutes: 1, toStationId: 's1' },
    { kind: 'wait', minutes: 2, lineId: 'l1', fromStationId: 's1', toStationId: 's1' },
    { kind: 'ride', minutes: 10, lineId: 'l1', fromStationId: 's1', toStationId: 's3' },
    { kind: 'walkOut', minutes: 1, fromStationId: 's3' },
  ],
  doorToDoorMinutes: 14,
  alternativeMinutes: 18,
};

describe('train following', () => {
  it('starts following a selected train', () => {
    expect(followReducer(idle, { type: 'start', trainId: 'l1-train-1', lineId: 'l1' }))
      .toEqual({ kind: 'followingTrain', trainId: 'l1-train-1', lineId: 'l1' });
  });

  it.each([
    ['drag', { type: 'drag' }],
    ['Escape', { type: 'escape' }],
    ['train disappears', { type: 'trainGone', trainId: 'l1-train-1' }],
    ['line is deleted', { type: 'lineDeleted', lineId: 'l1' }],
  ] as const)('stops following when %s', (_label, event) => {
    const following: FollowState = { kind: 'followingTrain', trainId: 'l1-train-1', lineId: 'l1' };
    expect(followReducer(following, event)).toEqual(idle);
  });

  it('targets the interpolated position of the followed train', () => {
    const following: FollowState = { kind: 'followingTrain', trainId: 'l1-train-2', lineId: 'l1' };
    expect(followCameraTarget([
      { id: 'l1-train-1', lineId: 'l1', lon: 121, lat: 25 },
      { id: 'l1-train-2', lineId: 'l1', lon: 121.25, lat: 25.15 },
    ], following)).toEqual({ lon: 121.25, lat: 25.15 });
    expect(followCameraTarget([], following)).toBeUndefined();
  });
});

describe('representative passenger following', () => {
  const following: FollowState = { kind: 'followingPassenger', trip: passenger, startGameTime: 120_000 };
  const ended: FollowState = { kind: 'passengerTripEnded', trip: passenger, startGameTime: 120_000 };

  it('keeps the trip after it ends and replays the same trip from the new game time', () => {
    expect(followReducer(idle, { type: 'startPassenger', trip: passenger, startGameTime: 120_000 })).toEqual(following);
    expect(followReducer(following, { type: 'tripFinished' })).toEqual(ended);
    expect(followReducer(ended, { type: 'replay', startGameTime: 300_000 }))
      .toEqual({ kind: 'followingPassenger', trip: passenger, startGameTime: 300_000 });
  });

  it('clears an ended passenger trip on drag, Escape, close, or station deletion', () => {
    for (const event of [
      { type: 'drag' },
      { type: 'escape' },
      { type: 'close' },
      { type: 'stationDeleted', stationId: 's3' },
    ] as const) {
      expect(followReducer(ended, event)).toEqual(idle);
    }
    expect(followReducer(ended, { type: 'stationDeleted', stationId: 'unrelated' })).toBe(ended);
  });

  it('clears an active passenger follow when dragged, escaped, closed, or a used station is deleted', () => {
    for (const event of [
      { type: 'drag' },
      { type: 'escape' },
      { type: 'close' },
      { type: 'stationDeleted', stationId: 's3' },
    ] as const) {
      expect(followReducer(following, event)).toEqual(idle);
    }
    expect(followReducer(following, { type: 'stationDeleted', stationId: 'unrelated' })).toBe(following);
  });

  it('interpolates the passenger at the start, midway through a ride, and trip end', () => {
    const coordinates = new Map([
      ['s1', { lon: 121, lat: 25 }],
      ['s3', { lon: 121.2, lat: 25.2 }],
    ]);
    expect(passengerPositionAt(passenger, coordinates, 0)).toEqual({ lon: 121, lat: 25 });
    expect(passengerPositionAt(passenger, coordinates, 8)).toEqual({ lon: 121.1, lat: 25.1 });
    expect(passengerPositionAt(passenger, coordinates, 14)).toEqual({ lon: 121.2, lat: 25.2 });
  });
});
