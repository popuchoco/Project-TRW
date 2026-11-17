import { describe, expect, it } from 'vitest';
import {
  buildDensityBreaks,
  densityClassIndex,
  populationDensity,
} from '../../src/map/village-density';

describe('village population density', () => {
  it('divides population by positive area in square kilometres', () => {
    expect(populationDensity(1200, 3)).toBe(400);
    expect(() => populationDensity(10, 0)).toThrow(RangeError);
    expect(() => populationDensity(-1, 1)).toThrow(RangeError);
  });

  it('builds deterministic quantile breaks for six sequential classes', () => {
    const densities = Array.from({ length: 60 }, (_, index) => index + 1);
    const breaks = buildDensityBreaks(densities);

    expect(breaks).toHaveLength(5);
    expect(breaks).toEqual([...breaks].sort((first, second) => first - second));
    expect(breaks[0]).toBeGreaterThan(0);
    expect(breaks[4]).toBeLessThan(60);
    expect(buildDensityBreaks(densities)).toEqual(breaks);
    expect(densityClassIndex(0, breaks)).toBe(0);
    expect(densityClassIndex(breaks[0]!, breaks)).toBe(0);
    expect(densityClassIndex(60, breaks)).toBe(5);
  });

  it('supports five to seven classes and handles ties or an empty sample', () => {
    expect(buildDensityBreaks([4, 4, 4], 5)).toEqual([4, 4, 4, 4]);
    expect(buildDensityBreaks([], 7)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(() => buildDensityBreaks([1, 2], 4)).toThrow(RangeError);
  });
});
