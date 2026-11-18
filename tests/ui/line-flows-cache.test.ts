import { describe, expect, it } from 'vitest';
import type { LineFlowsMessage } from '../../src/sim/protocol';
import type { LineFlowsData } from '../../src/sim/transit/TransitSim';
import { createLineFlowsCache } from '../../src/ui/line-flows-cache';

function line(lineId: string): LineFlowsData {
  return { lineId } as LineFlowsData;
}

function message(networkVersion: number, lines: LineFlowsData[]): LineFlowsMessage {
  return {
    type: 'lineFlows',
    gameDay: 1,
    periodId: 'peak' as LineFlowsMessage['periodId'],
    networkVersion,
    lines,
  };
}

describe('line flows cache', () => {
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

  it('updates only the requested line for a single-line response', () => {
    const cache = createLineFlowsCache();
    const blue = line('blue');
    const red = line('red');
    cache.apply(message(2, [blue, red]));
    const updatedBlue = line('blue');

    cache.apply(message(2, [updatedBlue]));
    expect(cache.get('blue')).toBe(updatedBlue);
    expect(cache.get('red')).toBe(red);
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
