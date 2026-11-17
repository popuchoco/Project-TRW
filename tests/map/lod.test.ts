import { afterEach, describe, expect, it, vi } from 'vitest';
import { chooseLod, LOD_THRESHOLDS, scheduleOnceOnIdleOrTrigger } from '../../src/map/lod';

afterEach(() => {
  vi.useRealTimers();
});

describe('LOD thresholds', () => {
  it('selects a single LOD from fit zoom through county detail', () => {
    expect(chooseLod(1)).toBe('lod0');
    expect(chooseLod(LOD_THRESHOLDS.lod1)).toBe('lod1');
    expect(chooseLod(LOD_THRESHOLDS.lod2)).toBe('lod2');
    expect(chooseLod(LOD_THRESHOLDS.lod3)).toBe('lod3');
    expect(chooseLod(100)).toBe('lod3');
  });
});

describe('deferred LOD preload scheduling', () => {
  it('runs at most once and cancels the timeout when triggered first', () => {
    vi.useFakeTimers();
    const preload = vi.fn();
    const trigger = scheduleOnceOnIdleOrTrigger(preload);

    vi.advanceTimersByTime(1499);
    expect(preload).not.toHaveBeenCalled();

    trigger();
    trigger();
    vi.advanceTimersByTime(1);

    expect(preload).toHaveBeenCalledTimes(1);
  });
});
