import { describe, expect, it } from 'vitest';
import type { LineFlowsMessage } from '../../src/sim/protocol';
import type { LineFlowsData } from '../../src/sim/transit/TransitSim';
import { createLineFlowsCache, planLineFlowRequests } from '../../src/ui/line-flows-cache';

function line(lineId: string): LineFlowsData {
  return { lineId } as LineFlowsData;
}

function message(networkVersion: number, lines: LineFlowsData[], requestId?: string): LineFlowsMessage {
  return {
    type: 'lineFlows',
    ...(requestId === undefined ? {} : { requestId }),
    gameDay: 1,
    periodId: 'peak' as LineFlowsMessage['periodId'],
    networkVersion,
    lines,
  };
}

describe('line flows cache', () => {
  it('plans no requests before the cache has a network version', () => {
    const cache = createLineFlowsCache();

    expect(planLineFlowRequests(cache, ['blue', 'red'], new Set())).toEqual([]);
  });

  it('plans uncached line requests in input order', () => {
    const cache = createLineFlowsCache();
    cache.apply(message(2, [line('red')]));

    expect(planLineFlowRequests(cache, ['blue', 'red', 'green'], new Set())).toEqual(['blue', 'green']);
  });

  it('excludes line requests that are already in flight', () => {
    const cache = createLineFlowsCache();
    cache.apply(message(2, []));

    expect(planLineFlowRequests(cache, ['blue', 'red'], new Set(['red']))).toEqual(['blue']);
  });

  it('discards messages from an older network version', () => {
    const cache = createLineFlowsCache();
    const current = line('blue');
    cache.apply(message(4, [current]));

    expect(cache.apply(message(3, [line('red')]))).toBe(false);
    expect(cache.networkVersion()).toBe(4);
    expect(cache.get('blue')).toBe(current);
    expect(cache.get('red')).toBeUndefined();
  });

  it('replaces the full cache for a full response', () => {
    const cache = createLineFlowsCache();
    cache.apply(message(2, [line('blue'), line('red')]));
    const updatedRed = line('red');
    const green = line('green');

    expect(cache.apply(message(2, [updatedRed, green]))).toBe(true);
    expect(cache.get('blue')).toBeUndefined();
    expect(cache.get('red')).toBe(updatedRed);
    expect(cache.get('green')).toBe(green);
  });

  it('keeps the cache unchanged for an empty requested reply', () => {
    const cache = createLineFlowsCache();
    const blue = line('blue');
    const red = line('red');
    cache.apply(message(2, [blue, red]));

    expect(cache.apply(message(2, [], 'missing-line-request'))).toBe(false);
    expect(cache.get('blue')).toBe(blue);
    expect(cache.get('red')).toBe(red);
  });

  it('updates only the requested line for a single-line response', () => {
    const cache = createLineFlowsCache();
    const blue = line('blue');
    const red = line('red');
    cache.apply(message(2, [blue, red]));
    const updatedBlue = line('blue');

    cache.apply(message(2, [updatedBlue], 'blue-request'));
    expect(cache.get('blue')).toBe(updatedBlue);
    expect(cache.get('red')).toBe(red);
  });

  it('merges a requested multi-line response without removing other lines', () => {
    const cache = createLineFlowsCache();
    const blue = line('blue');
    const red = line('red');
    cache.apply(message(2, [blue, red]));
    const updatedRed = line('red');
    const green = line('green');

    expect(cache.apply(message(2, [updatedRed, green], 'all-lines-request'))).toBe(true);
    expect(cache.get('blue')).toBe(blue);
    expect(cache.get('red')).toBe(updatedRed);
    expect(cache.get('green')).toBe(green);
  });

  it('replaces the full cache for an unsolicited one-line response', () => {
    const cache = createLineFlowsCache();
    cache.apply(message(2, [line('blue'), line('red')]));
    const green = line('green');

    expect(cache.apply(message(2, [green]))).toBe(true);
    expect(cache.get('blue')).toBeUndefined();
    expect(cache.get('red')).toBeUndefined();
    expect(cache.get('green')).toBe(green);
  });

  it('clears the old cache when the network version changes', () => {
    const cache = createLineFlowsCache();
    cache.apply(message(2, [line('blue'), line('red')]));
    const green = line('green');

    expect(cache.apply(message(3, [green], 'green-request'))).toBe(true);
    expect(cache.get('blue')).toBeUndefined();
    expect(cache.get('red')).toBeUndefined();
    expect(cache.get('green')).toBe(green);
    expect(cache.networkVersion()).toBe(3);
  });

  it('clears all cached data and the version', () => {
    const cache = createLineFlowsCache();
    cache.apply(message(2, [line('blue'), line('red')]));

    cache.clear();
    expect(cache.networkVersion()).toBeUndefined();
    expect(cache.get('blue')).toBeUndefined();
    expect(cache.get('red')).toBeUndefined();
  });
});
