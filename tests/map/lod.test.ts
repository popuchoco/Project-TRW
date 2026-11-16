import { describe, expect, it } from 'vitest';
import { chooseLod, LOD_THRESHOLDS } from '../../src/map/lod';

describe('LOD thresholds', () => {
  it('selects a single LOD from fit zoom through county detail', () => {
    expect(chooseLod(1)).toBe('lod0');
    expect(chooseLod(LOD_THRESHOLDS.lod1)).toBe('lod1');
    expect(chooseLod(LOD_THRESHOLDS.lod2)).toBe('lod2');
    expect(chooseLod(LOD_THRESHOLDS.lod3)).toBe('lod3');
    expect(chooseLod(100)).toBe('lod3');
  });
});
