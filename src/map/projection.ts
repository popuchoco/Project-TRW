import type { BBox, Position } from './types';

/** Equirectangular map plane scaled to Taiwan's mean latitude. */
export const PROJECTION_REFERENCE_LATITUDE = 23.7;
export const PROJECTION_X_SCALE = Math.cos((PROJECTION_REFERENCE_LATITUDE * Math.PI) / 180);

export interface PlanePoint {
  x: number;
  y: number;
}

/** Project [longitude, latitude] degrees to a y-down map plane. */
export function project([longitude, latitude]: Position): PlanePoint {
  return { x: longitude * PROJECTION_X_SCALE, y: -latitude };
}

/** Inverse of project(). */
export function unproject({ x, y }: PlanePoint): Position {
  return [x / PROJECTION_X_SCALE, -y];
}

/** Project a geographic bbox while accounting for the inverted y axis. */
export function projectBBox([minLon, minLat, maxLon, maxLat]: BBox): BBox {
  return [minLon * PROJECTION_X_SCALE, -maxLat, maxLon * PROJECTION_X_SCALE, -minLat];
}

/** Inverse of projectBBox(). */
export function unprojectBBox([minX, minY, maxX, maxY]: BBox): BBox {
  return [minX / PROJECTION_X_SCALE, -maxY, maxX / PROJECTION_X_SCALE, -minY];
}
