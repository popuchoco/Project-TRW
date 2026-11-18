import { describe, expect, it } from 'vitest';
import type { Network } from '../../src/city/network';
import { createStationCoordCache } from '../../src/render/station-coords';

function network(stations: Network['stations']): Network {
  return { stations, lines: [], nextId: stations.length + 1 };
}

describe('station coordinate cache', () => {
  it('builds coordinates once for the same network and rebuilds for a new network', () => {
    const cache = createStationCoordCache();
    const firstNetwork = network([
      { id: 's1', name: '第一站', lon: 121.5, lat: 25.0 },
      { id: 's2', name: '第二站', lon: 121.6, lat: 25.1 },
    ]);

    const first = cache.get(firstNetwork);
    for (let index = 0; index < 20; index += 1) {
      expect(cache.get(firstNetwork)).toBe(first);
    }
    expect(cache.getBuildCount()).toBe(1);
    expect(first.get('s1')).toEqual({ lon: 121.5, lat: 25.0 });
    expect(first.get('s2')).toEqual({ lon: 121.6, lat: 25.1 });

    const secondNetwork = network([
      { id: 's1', name: '第一站', lon: 122, lat: 24.9 },
    ]);
    const second = cache.get(secondNetwork);

    expect(second).not.toBe(first);
    expect(cache.getBuildCount()).toBe(2);
    expect(second.get('s1')).toEqual({ lon: 122, lat: 24.9 });
  });
});
