import { describe, expect, it, vi } from 'vitest';
import type { RepresentativePassenger } from '../../src/sim/transit/representative';
import { createPassengerRequestHandler, nextPassengerStationId } from '../../src/ui/passenger-request';

const trip: RepresentativePassenger = {
  selectedStationId: 's1',
  odKey: 's1>s2',
  flow: 1,
  startStationId: 's1',
  endStationId: 's2',
  pathSignature: 'l1:s1>s2',
  legs: [],
  doorToDoorMinutes: 10,
  alternativeMinutes: null,
};

describe('next passenger station', () => {
  it('returns the next station in trip order', () => {
    expect(nextPassengerStationId({
      ...trip,
      selectedStationId: 's2',
      startStationId: 's1',
      endStationId: 's3',
      legs: [
        { kind: 'ride', minutes: 4, fromStationId: 's1', toStationId: 's2' },
        { kind: 'ride', minutes: 5, fromStationId: 's2', toStationId: 's3' },
      ],
    })).toBe('s3');
  });

  it('wraps from the final station to the first', () => {
    expect(nextPassengerStationId({
      ...trip,
      selectedStationId: 's3',
      startStationId: 's1',
      endStationId: 's3',
      legs: [{ kind: 'ride', minutes: 9, fromStationId: 's1', toStationId: 's3' }],
    })).toBe('s1');
  });

  it('deduplicates stations while preserving their first-seen order', () => {
    expect(nextPassengerStationId({
      ...trip,
      selectedStationId: 's3',
      startStationId: 's1',
      endStationId: 's2',
      legs: [
        { kind: 'ride', minutes: 4, fromStationId: 's1', toStationId: 's2' },
        { kind: 'ride', minutes: 5, fromStationId: 's2', toStationId: 's3' },
      ],
    })).toBe('s1');
  });

  it('returns undefined when the trip has only one distinct station', () => {
    expect(nextPassengerStationId({
      ...trip,
      selectedStationId: 's1',
      startStationId: 's1',
      endStationId: 's1',
      legs: [{ kind: 'ride', minutes: 0, fromStationId: 's1', toStationId: 's1' }],
    })).toBeUndefined();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function setup() {
  let networkVersion = 1;
  let metroView = true;
  let metroViewRevision = 0;
  const followPassenger = vi.fn(() => true);
  const showStatus = vi.fn();
  const handleRequest = createPassengerRequestHandler({
    getNetworkVersion: () => networkVersion,
    isMetroViewActive: () => metroView,
    getMetroViewRevision: () => metroViewRevision,
    followPassenger,
    getGameTime: (client) => client.getStatus().gameTimeMs,
    showStatus,
  });
  const client = (promise: Promise<RepresentativePassenger | null>) => ({
    requestRepresentativePassenger: vi.fn(() => promise),
    getStatus: () => ({ gameTimeMs: 42 }),
  });
  return {
    handleRequest,
    followPassenger,
    showStatus,
    client,
    changeNetwork: () => { networkVersion += 1; },
    leaveMetroView: () => {
      metroView = false;
      metroViewRevision += 1;
    },
    reenterMetroView: () => {
      metroView = true;
      metroViewRevision += 1;
    },
  };
}

describe('representative passenger request guard', () => {
  it('discards a response after the network changes', async () => {
    const state = setup();
    const pending = deferred<RepresentativePassenger | null>();
    const request = state.handleRequest('s1', state.client(pending.promise));

    state.changeNetwork();
    pending.resolve(trip);
    await request;

    expect(state.followPassenger).not.toHaveBeenCalled();
    expect(state.showStatus).toHaveBeenCalledWith('路網或畫面已變更，已取消跟隨代表旅客。');
  });

  it('discards a response after leaving metro view', async () => {
    const state = setup();
    const pending = deferred<RepresentativePassenger | null>();
    const request = state.handleRequest('s1', state.client(pending.promise));

    state.leaveMetroView();
    pending.resolve(trip);
    await request;

    expect(state.followPassenger).not.toHaveBeenCalled();
    expect(state.showStatus).toHaveBeenCalledWith('路網或畫面已變更，已取消跟隨代表旅客。');
  });

  it('discards an older response when a newer request was sent', async () => {
    const state = setup();
    const oldPending = deferred<RepresentativePassenger | null>();
    const newPending = deferred<RepresentativePassenger | null>();
    const oldRequest = state.handleRequest('s1', state.client(oldPending.promise));
    const newRequest = state.handleRequest('s2', state.client(newPending.promise));

    oldPending.resolve(trip);
    await oldRequest;
    expect(state.followPassenger).not.toHaveBeenCalled();

    newPending.resolve(trip);
    await newRequest;
    expect(state.followPassenger).toHaveBeenCalledOnce();
  });

  it('follows a current response using the client game time', async () => {
    const state = setup();
    const pending = deferred<RepresentativePassenger | null>();
    const request = state.handleRequest('s1', state.client(pending.promise));

    pending.resolve(trip);
    await request;

    expect(state.followPassenger).toHaveBeenCalledWith(trip, 42);
    expect(state.showStatus).not.toHaveBeenCalled();
  });

  it('discards a response if the view was left and re-entered', async () => {
    const state = setup();
    const pending = deferred<RepresentativePassenger | null>();
    const request = state.handleRequest('s1', state.client(pending.promise));

    state.leaveMetroView();
    state.reenterMetroView();
    pending.resolve(trip);
    await request;

    expect(state.followPassenger).not.toHaveBeenCalled();
  });
});
