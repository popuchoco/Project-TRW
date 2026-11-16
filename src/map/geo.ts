import type { BBox, GeoFeature, MultiPolygonGeometry, Position, TownProperties } from './types';

export function bboxForPositions(positions: Position[]): BBox {
  if (positions.length === 0) throw new Error('Cannot calculate a bbox for an empty position list');
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of positions) {
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
  }
  return [minLon, minLat, maxLon, maxLat];
}

export function bboxForGeometry(geometry: MultiPolygonGeometry): BBox {
  const positions = geometry.coordinates.flat(2);
  return bboxForPositions(positions);
}

export function bboxContainsPoint(bbox: BBox, lon: number, lat: number): boolean {
  return lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
}

function pointOnSegment(
  lon: number,
  lat: number,
  [x1, y1]: Position,
  [x2, y2]: Position,
): boolean {
  const cross = (lon - x1) * (y2 - y1) - (lat - y1) * (x2 - x1);
  if (Math.abs(cross) > 1e-10) return false;
  const dot = (lon - x1) * (lon - x2) + (lat - y1) * (lat - y2);
  return dot <= 1e-10;
}

function ringContainsPoint(ring: Position[], lon: number, lat: number): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const currentPosition = ring[index];
    const previousPosition = ring[previous];
    if (!currentPosition || !previousPosition) continue;
    if (pointOnSegment(lon, lat, previousPosition, currentPosition)) return true;
    const [currentLon, currentLat] = currentPosition;
    const [previousLon, previousLat] = previousPosition;
    const crosses = (currentLat > lat) !== (previousLat > lat);
    if (crosses && lon < ((previousLon - currentLon) * (lat - currentLat)) / (previousLat - currentLat) + currentLon) {
      inside = !inside;
    }
  }
  return inside;
}

/** Even-odd fill across an outer ring and its holes. */
export function pointInPolygon(rings: Position[][], lon: number, lat: number): boolean {
  let inside = false;
  for (const ring of rings) {
    if (ringContainsPoint(ring, lon, lat)) inside = !inside;
  }
  return inside;
}

export function pointInMultiPolygon(
  polygons: Position[][][],
  lon: number,
  lat: number,
): boolean {
  return polygons.some((rings) => pointInPolygon(rings, lon, lat));
}

export function featureContainsPoint(
  feature: GeoFeature<TownProperties>,
  lon: number,
  lat: number,
): boolean {
  const bbox = bboxForGeometry(feature.geometry);
  return bboxContainsPoint(bbox, lon, lat) && pointInMultiPolygon(feature.geometry.coordinates, lon, lat);
}
