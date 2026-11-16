import { bboxContainsPoint, bboxForGeometry, pointInMultiPolygon } from './geo';
import type { GeoFeature, TownProperties } from './types';

/** Return the first main-map town containing a point; inset copies are excluded. */
export function lookupTown(
  features: GeoFeature<TownProperties>[],
  lon: number,
  lat: number,
): GeoFeature<TownProperties> | undefined {
  for (const feature of features) {
    if (feature.properties.inset) continue;
    const bbox = bboxForGeometry(feature.geometry);
    if (!bboxContainsPoint(bbox, lon, lat)) continue;
    if (pointInMultiPolygon(feature.geometry.coordinates, lon, lat)) return feature;
  }
  return undefined;
}
