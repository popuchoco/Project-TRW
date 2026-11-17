import { describe, expect, it } from 'vitest';
import { project } from '../../src/map/projection';
import {
  decodeVillageGeometry,
  multiPolygonAreaKm2,
  VILLAGE_GEOMETRY_VERSION,
  VILLAGE_PROJECTION_VERSION,
} from '../../src/map/village-geometry';
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
});
