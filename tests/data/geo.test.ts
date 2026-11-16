import { describe, expect, it } from 'vitest';
import { pointInPolygon } from '../../src/map/geo';

describe('pointInPolygon', () => {
  const polygon = [
    [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
    [[3, 3], [7, 3], [7, 7], [3, 7], [3, 3]],
  ] as [number, number][][];

  it('uses even-odd fill so holes are excluded', () => {
    expect(pointInPolygon(polygon, 1, 1)).toBe(true);
    expect(pointInPolygon(polygon, 5, 5)).toBe(false);
  });
});
