import { pointInMultiPolygon } from '../map/geo';
import type { MultiPolygonGeometry } from '../map/types';
import type { VillageAt } from './commands';

export interface VillageArea {
  name: string;
  townName: string;
  geometry: MultiPolygonGeometry;
}

/**
 * Build the pure coordinate lookup used by station naming from decoded village
 * polygons. Shared-boundary points resolve to the first village in input order.
 */
export function createVillageAtLookup(villages: readonly VillageArea[]): VillageAt {
  const areas = [...villages];
  return (lon, lat) => {
    const village = areas.find(({ geometry }) => pointInMultiPolygon(geometry.coordinates, lon, lat));
    return village ? { name: village.name, townName: village.townName } : undefined;
  };
}
