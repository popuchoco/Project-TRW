import { describe, expect, it } from 'vitest';
import { decodeTopology } from '../../src/map/topology';
import type { Topology } from '../../src/map/types';

describe('decodeTopology', () => {
  const topology: Topology = {
    type: 'Topology',
    transform: { scale: [0.01, 0.01], translate: [120, 23] },
    arcs: [
      [[0, 0], [100, 0], [0, 100], [-100, 0], [0, -100]],
      [[20, 20], [60, 0], [0, 60], [-60, 0], [0, -60]],
    ],
    objects: {
      towns: {
        type: 'GeometryCollection',
        geometries: [
          {
            type: 'Polygon',
            arcs: [[0], [1]],
            properties: {
              TOWNCODE: 'test',
              COUNTYCODE: 'county',
              COUNTYNAME: '測試縣',
              TOWNNAME: '測試鎮',
              TOWNENG: 'Test Township',
            },
          },
        ],
      },
    },
  };

  it('applies the quantized delta transform and keeps polygon holes', () => {
    const [feature] = decodeTopology(topology, 'towns');
    expect(feature?.properties.TOWNCODE).toBe('test');
    expect(feature?.geometry.coordinates[0]?.[0]).toEqual([
      [120, 23],
      [121, 23],
      [121, 24],
      [120, 24],
      [120, 23],
    ]);
    expect(feature?.geometry.coordinates[0]?.[1]?.[0]).toEqual([120.2, 23.2]);
  });

  it('joins reversed arc references', () => {
    const reversed: Topology = {
      ...topology,
      objects: {
        reverse: {
          type: 'Polygon',
          arcs: [[~0]],
          properties: {
            TOWNCODE: 'reverse',
            COUNTYCODE: 'county',
            COUNTYNAME: '測試縣',
            TOWNNAME: '反向鎮',
            TOWNENG: 'Reverse Township',
          },
        },
      },
    };
    const [feature] = decodeTopology(reversed);
    expect(feature?.geometry.coordinates[0]?.[0]?.[1]).toEqual([120, 24]);
  });
});
