import { describe, expect, it } from 'vitest';
import { QuadTree } from '../../src/map/quadtree';

describe('bbox quadtree', () => {
  const entries = [
    { id: 'west', bbox: [0, 0, 2, 2] as [number, number, number, number] },
    { id: 'east', bbox: [5, 4, 7, 6] as [number, number, number, number] },
    { id: 'wide', bbox: [1, 1, 6, 5] as [number, number, number, number] },
  ];
  const index = new QuadTree(entries, (entry) => entry.bbox, 1);

  it('returns entries containing a point', () => {
    expect(index.query([1, 1]).map(({ id }) => id).sort()).toEqual(['west', 'wide']);
    expect(index.queryPoint(6, 5).map(({ id }) => id).sort()).toEqual(['east', 'wide']);
  });

  it('returns bbox intersections for a viewport rectangle', () => {
    expect(index.queryRect([4.5, 3.5, 6.5, 5.5]).map(({ id }) => id).sort()).toEqual(['east', 'wide']);
    expect(index.query([10, 10, 11, 11])).toEqual([]);
  });
});
