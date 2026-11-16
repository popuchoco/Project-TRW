import { bboxContainsPoint, bboxForGeometry, pointInMultiPolygon } from './geo';
import { QuadTree } from './quadtree';
import type { GeoFeature, TownProperties } from './types';

export type TownFeature = GeoFeature<TownProperties>;

export function buildTownIndex(features: readonly TownFeature[], includeInsets = false): QuadTree<TownFeature> {
  const towns = includeInsets ? features : features.filter(({ properties }) => !properties.inset);
  return new QuadTree(towns, (feature) => bboxForGeometry(feature.geometry));
}

/** Spatially indexed main-map hit test. */
export function lookupTownIndexed(
  index: QuadTree<TownFeature>,
  lon: number,
  lat: number,
): TownFeature | undefined {
  return index.queryPoint(lon, lat).find((feature) =>
    !feature.properties.inset && pointInMultiPolygon(feature.geometry.coordinates, lon, lat));
}

/** Hit test an inset's feature while preserving its owning town metadata. */
export function lookupInset(
  features: readonly TownFeature[],
  insetId: string,
  lon: number,
  lat: number,
): TownFeature | undefined {
  return features.find((feature) => feature.properties.inset === insetId &&
    bboxContainsPoint(bboxForGeometry(feature.geometry), lon, lat) &&
    pointInMultiPolygon(feature.geometry.coordinates, lon, lat));
}

/** Return the first main-map town containing a point; inset copies are excluded. */
export function lookupTown(
  features: TownFeature[],
  lon: number,
  lat: number,
): TownFeature | undefined {
  for (const feature of features) {
    if (feature.properties.inset) continue;
    const bbox = bboxForGeometry(feature.geometry);
    if (!bboxContainsPoint(bbox, lon, lat)) continue;
    if (pointInMultiPolygon(feature.geometry.coordinates, lon, lat)) return feature;
  }
  return undefined;
}
