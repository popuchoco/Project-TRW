import type { Network } from '../city/network';
import type { PassengerCoordinate } from '../city/follow';

export interface StationCoordCache {
  get(network: Network): ReadonlyMap<string, PassengerCoordinate>;
  getBuildCount(): number;
}

/** Memoizes station coordinates by immutable network identity. */
export function createStationCoordCache(): StationCoordCache {
  const coordinatesByNetwork = new WeakMap<Network, ReadonlyMap<string, PassengerCoordinate>>();
  let buildCount = 0;

  return {
    get(network) {
      const cached = coordinatesByNetwork.get(network);
      if (cached) return cached;

      const coordinates = new Map(network.stations.map(({ id, lon, lat }) => [id, { lon, lat }]));
      coordinatesByNetwork.set(network, coordinates);
      buildCount += 1;
      return coordinates;
    },
    getBuildCount: () => buildCount,
  };
}
