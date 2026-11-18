import { describe, expect, it } from 'vitest';
import { project } from '../../src/map/projection';
import {
  decodeVillageGeometry,
  mergeVillageGeometry,
  multiPolygonAreaKm2,
  VILLAGE_GEOMETRY_VERSION,
  VILLAGE_PROJECTION_VERSION,
} from '../../src/map/village-geometry';
import { VillageGeometryLookup } from '../../src/map/village-lookup';
import type { VillageGeometryAttribute } from '../../src/map/village-geometry';
import type { Topology } from '../../src/map/types';

const square = [
  [121, 25], [122, 25], [122, 26], [121, 26], [121, 25],
] as [number, number][];
const hole = [
  [121.2, 25.2], [121.4, 25.2], [121.4, 25.4], [121.2, 25.4], [121.2, 25.2],
] as [number, number][];
const island = [
  [123, 25], [123.2, 25], [123.2, 25.2], [123, 25.2], [123, 25],
] as [number, number][];

const topology: Topology = {
  type: 'Topology',
  arcs: [square, hole, island],
  objects: {
    'north-north-simplified': {
      type: 'GeometryCollection',
      geometries: [
        {
          type: 'Polygon',
          arcs: [[0], [1]],
          properties: { VILLCODE: 'B' },
        },
        {
          type: 'MultiPolygon',
          arcs: [[[2]]],
          properties: { VILLCODE: 'A' },
        },
      ],
    },
  },
};

function attribute(VILLCODE: string): VillageGeometryAttribute {
  return {
    VILLCODE,
    name: `里${VILLCODE}`,
    TOWNCODE: '63000010',
    townName: '松山區',
    population: 100,
    households: 40,
    populationMatched: true,
    demandPoint: [121.5, 25.1],
  };
}

function singleVillageTopology(VILLCODE: string): Topology {
  return {
    type: 'Topology',
    arcs: [square],
    objects: {
      'north-north-simplified': {
        type: 'GeometryCollection',
        geometries: [{ type: 'Polygon', arcs: [[0]], properties: { VILLCODE } }],
      },
    },
  };
}

describe('decodeVillageGeometry', () => {
  it('encodes projected rings, monotonic offsets, VILLCODE indices, and the version header', () => {
    const result = decodeVillageGeometry(topology, [attribute('B'), attribute('A')]);

    expect(result.header).toEqual({
      version: VILLAGE_GEOMETRY_VERSION,
      projection: VILLAGE_PROJECTION_VERSION,
    });
    expect(result.coords).toBeInstanceOf(Float32Array);
    expect(result.ringOffsets).toBeInstanceOf(Uint32Array);
    expect(result.ringOffsets[0]).toBe(0);
    expect(result.ringOffsets[result.ringOffsets.length - 1]).toBe(result.coords.length / 2);
    for (let index = 1; index < result.ringOffsets.length; index += 1) {
      expect(result.ringOffsets[index]).toBeGreaterThanOrEqual(result.ringOffsets[index - 1]!);
    }
    expect(result.ringOffsets).toHaveLength(4);
    expect(result.villages.map(({ VILLCODE }) => VILLCODE)).toEqual(['A', 'B']);
    expect(Array.from(result.ringVillageIndices)).toEqual([0, 1, 1]);
    expect(Array.from(result.ringVillageIndices, (villageIndex) => result.villages[villageIndex]!.VILLCODE))
      .toEqual(['A', 'B', 'B']);
    expect(Array.from(result.ringPolygonIndices)).toEqual([0, 1, 1]);

    const firstProjectedPoint = project([123, 25]);
    expect(result.coords[0]).toBeCloseTo(firstProjectedPoint.x, 5);
    expect(result.coords[1]).toBeCloseTo(firstProjectedPoint.y, 5);
  });

  it('preserves polygon holes as separate rings flagged within their polygon', () => {
    const result = decodeVillageGeometry(topology, [attribute('A'), attribute('B')]);
    const holeRing = Array.from(result.ringIsHole).findIndex((value) => value === 1);

    expect(Array.from(result.ringIsHole)).toEqual([0, 0, 1]);
    expect(result.ringVillageIndices[holeRing]).toBe(1);
    expect(result.ringPolygonIndices[holeRing]).toBe(1);
    expect(result.ringOffsets[holeRing + 1]! - result.ringOffsets[holeRing]!).toBe(hole.length);
    const village = result.villages.find(({ VILLCODE }) => VILLCODE === 'B')!;
    expect(village.areaKm2).toBeGreaterThan(0);
    expect(village.densityPerKm2).toBeCloseTo(village.population / village.areaKm2, 10);
  });

  it('calculates spherical polygon area in km² and subtracts holes', () => {
    const fullArea = multiPolygonAreaKm2([[square]]);
    const holedArea = multiPolygonAreaKm2([[square, hole]]);

    expect(fullArea).toBeGreaterThan(10_000);
    expect(holedArea).toBeGreaterThan(0);
    expect(holedArea).toBeLessThan(fullArea);
    expect(multiPolygonAreaKm2([[square], [island]])).toBeGreaterThan(fullArea);
  });

  it('looks up villages from projected geometry buffers and respects polygon holes', () => {
    const geometry = decodeVillageGeometry(topology, [attribute('A'), attribute('B')]);
    const lookup = new VillageGeometryLookup(geometry);

    expect(lookup.find(123.1, 25.1)?.VILLCODE).toBe('A');
    expect(lookup.find(121.1, 25.1)?.VILLCODE).toBe('B');
    expect(lookup.find(121.3, 25.3)).toBeUndefined();
    expect(lookup.find(124, 25)).toBeUndefined();
  });
});

describe('mergeVillageGeometry', () => {
  it('merges ordered decoded parts with the same villages, rings, and shifted indices as one decode', () => {
    const first = decodeVillageGeometry({
      type: 'Topology',
      arcs: [square, hole],
      objects: {
        'north-north-simplified': {
          type: 'GeometryCollection',
          geometries: [{ type: 'Polygon', arcs: [[0], [1]], properties: { VILLCODE: 'A' } }],
        },
      },
    }, [attribute('A')]);
    const second = decodeVillageGeometry({
      type: 'Topology',
      arcs: [island, square],
      objects: {
        'north-north-simplified': {
          type: 'GeometryCollection',
          geometries: [{ type: 'MultiPolygon', arcs: [[[0]], [[1]]], properties: { VILLCODE: 'B' } }],
        },
      },
    }, [attribute('B')]);
    const combined = decodeVillageGeometry({
      type: 'Topology',
      arcs: [square, hole, island, square],
      objects: {
        'north-north-simplified': {
          type: 'GeometryCollection',
          geometries: [
            { type: 'Polygon', arcs: [[0], [1]], properties: { VILLCODE: 'A' } },
            { type: 'MultiPolygon', arcs: [[[2]], [[3]]], properties: { VILLCODE: 'B' } },
          ],
        },
      },
    }, [attribute('B'), attribute('A')]);
    const merged = mergeVillageGeometry([first, second]);

    expect(merged.villages).toEqual(combined.villages);
    expect(merged.ringIsHole).toHaveLength(combined.ringIsHole.length);
    expect(Array.from(merged.ringOffsets)).toEqual(Array.from(combined.ringOffsets));
    expect(Array.from(merged.ringVillageIndices)).toEqual([0, 0, 1, 1]);
    expect(Array.from(merged.ringPolygonIndices)).toEqual([0, 0, 1, 2]);
    expect(Array.from(merged.ringIsHole)).toEqual([0, 1, 0, 0]);
    expect(Array.from(merged.coords)).toEqual(Array.from(combined.coords));
  });

  it('returns the same object for a single part', () => {
    const part = decodeVillageGeometry(singleVillageTopology('A'), [attribute('A')]);

    expect(mergeVillageGeometry([part])).toBe(part);
  });

  it('throws for overlapping or out-of-order village codes', () => {
    const a = decodeVillageGeometry(singleVillageTopology('A'), [attribute('A')]);
    const b = decodeVillageGeometry(singleVillageTopology('B'), [attribute('B')]);

    expect(() => mergeVillageGeometry([a, a])).toThrow();
    expect(() => mergeVillageGeometry([b, a])).toThrow();
  });
});
