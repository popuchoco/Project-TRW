import { project } from './projection';
import { decodeTopology } from './topology';
import { populationDensity } from './village-density';
import type { MultiPolygonGeometry, PolygonCoordinates, Position, Topology } from './types';

export const VILLAGE_GEOMETRY_VERSION = 2 as const;
export const VILLAGE_PROJECTION_VERSION = 'trw-equirectangular-23.7-v1' as const;

export interface VillageGeometryAttribute {
  VILLCODE: string;
  name: string;
  TOWNCODE: string;
  townName: string;
  population: number;
  households: number;
  populationMatched: boolean;
  demandPoint: Position;
}

export interface VillageGeometryRecord extends VillageGeometryAttribute {
  /** Spherical polygon area, with interior rings subtracted, in km². */
  areaKm2: number;
  /** Worker-computed density in people/km²; unmatched villages have no density. */
  densityPerKm2: number | null;
}

export interface VillageGeometryData {
  header: {
    version: typeof VILLAGE_GEOMETRY_VERSION;
    projection: typeof VILLAGE_PROJECTION_VERSION;
  };
  /** Projected x/y values, alternating; offsets count coordinate pairs. */
  coords: Float32Array;
  /** Ring i occupies coords[ringOffsets[i] * 2 .. ringOffsets[i + 1] * 2]. */
  ringOffsets: Uint32Array;
  /** Index into the VILLCODE-sorted `villages` table for each ring. */
  ringVillageIndices: Uint32Array;
  /** Polygon index within the full, VILLCODE-sorted village table. */
  ringPolygonIndices: Uint32Array;
  /** 0 for polygon exteriors, 1 for interior rings. */
  ringIsHole: Uint8Array;
  villages: VillageGeometryRecord[];
}

interface VillageTopologyFeature {
  properties?: Record<string, unknown>;
  geometry: MultiPolygonGeometry;
}

function compareCode(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}

function copyAndValidateAttribute(source: VillageGeometryAttribute): VillageGeometryAttribute {
  if (typeof source.VILLCODE !== 'string' || source.VILLCODE.length === 0
    || typeof source.name !== 'string'
    || typeof source.TOWNCODE !== 'string'
    || typeof source.townName !== 'string'
    || !Number.isFinite(source.population) || source.population < 0
    || !Number.isFinite(source.households) || source.households < 0
    || typeof source.populationMatched !== 'boolean'
    || !Array.isArray(source.demandPoint) || source.demandPoint.length !== 2
    || !Number.isFinite(source.demandPoint[0]) || !Number.isFinite(source.demandPoint[1])) {
    throw new Error(`Village attributes are invalid for VILLCODE ${String(source.VILLCODE)}.`);
  }
  return { ...source, demandPoint: [source.demandPoint[0], source.demandPoint[1]] };
}

const EARTH_RADIUS_KM = 6371.0088;
const DEGREES_TO_RADIANS = Math.PI / 180;

function sphericalRingAreaKm2(ring: Position[]): number {
  let sum = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index]!;
    const next = ring[(index + 1) % ring.length]!;
    const longitudeDelta = (next[0] - current[0]) * DEGREES_TO_RADIANS;
    const currentLatitude = current[1] * DEGREES_TO_RADIANS;
    const nextLatitude = next[1] * DEGREES_TO_RADIANS;
    sum += longitudeDelta * (2 + Math.sin(currentLatitude) + Math.sin(nextLatitude));
  }
  return Math.abs(sum) * EARTH_RADIUS_KM * EARTH_RADIUS_KM / 2;
}

/** Spherical area in km²; the first ring is the exterior and later rings are holes. */
export function multiPolygonAreaKm2(polygons: PolygonCoordinates): number {
  let area = 0;
  for (const polygon of polygons) {
    const [outer, ...holes] = polygon;
    if (!outer) continue;
    area += sphericalRingAreaKm2(outer);
    for (const hole of holes) area -= sphericalRingAreaKm2(hole);
  }
  return Math.max(0, area);
}

/** 北北 keeps its historical object name; a single-object file (e.g. 桃園 `taoyuan-simplified`) uses that object. */
function villageObjectName(topology: Topology): string {
  const names = Object.keys(topology.objects ?? {});
  return names.length === 1 ? names[0]! : 'north-north-simplified';
}

/** Decode village TopoJSON and encode projected rings with attribute indices. */
export function decodeVillageGeometry(
  topology: Topology,
  sourceAttributes: readonly VillageGeometryAttribute[],
): VillageGeometryData {
  const features = decodeTopology(topology, villageObjectName(topology)) as unknown as VillageTopologyFeature[];
  const sourceVillages = sourceAttributes.map(copyAndValidateAttribute).sort((a, b) => compareCode(a.VILLCODE, b.VILLCODE));
  for (let index = 1; index < sourceVillages.length; index += 1) {
    if (sourceVillages[index - 1]!.VILLCODE === sourceVillages[index]!.VILLCODE) {
      throw new Error(`Village attributes contain a duplicate VILLCODE: ${sourceVillages[index]!.VILLCODE}`);
    }
  }

  const featuresByCode = new Map<string, VillageTopologyFeature>();
  for (const feature of features) {
    const code = feature.properties?.VILLCODE;
    if (typeof code !== 'string' || code.length === 0 || featuresByCode.has(code)) {
      throw new Error(`Village topology has a missing or duplicate VILLCODE: ${String(code ?? '')}`);
    }
    featuresByCode.set(code, feature);
  }
  if (featuresByCode.size !== sourceVillages.length) {
    throw new Error(`Village topology and attribute counts do not match (${featuresByCode.size} and ${sourceVillages.length}).`);
  }

  const coords: number[] = [];
  const ringOffsets: number[] = [0];
  const ringVillageIndices: number[] = [];
  const ringPolygonIndices: number[] = [];
  const ringIsHole: number[] = [];
  const villages: VillageGeometryRecord[] = [];
  let polygonIndex = 0;

  for (let villageIndex = 0; villageIndex < sourceVillages.length; villageIndex += 1) {
    const village = sourceVillages[villageIndex]!;
    const feature = featuresByCode.get(village.VILLCODE);
    if (!feature) throw new Error(`Village topology is missing ${village.VILLCODE}.`);
    const areaKm2 = multiPolygonAreaKm2(feature.geometry.coordinates);
    if (!Number.isFinite(areaKm2) || areaKm2 <= 0) {
      throw new Error(`Village ${village.VILLCODE} has no measurable polygon area.`);
    }
    villages.push({
      ...village,
      areaKm2,
      densityPerKm2: village.populationMatched ? populationDensity(village.population, areaKm2) : null,
    });

    for (const polygon of feature.geometry.coordinates) {
      if (polygon.length === 0) throw new Error(`Village ${village.VILLCODE} contains a polygon without rings.`);
      for (let ringIndex = 0; ringIndex < polygon.length; ringIndex += 1) {
        const ring = polygon[ringIndex]!;
        if (ring.length < 3) throw new Error(`Village ${village.VILLCODE} contains a ring with fewer than three points.`);
        for (const [longitude, latitude] of ring) {
          const point = project([longitude, latitude]);
          if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
            throw new Error(`Village ${village.VILLCODE} has invalid coordinates.`);
          }
          coords.push(point.x, point.y);
        }
        ringOffsets.push(coords.length / 2);
        ringVillageIndices.push(villageIndex);
        ringPolygonIndices.push(polygonIndex);
        ringIsHole.push(ringIndex === 0 ? 0 : 1);
      }
      polygonIndex += 1;
    }
  }

  return {
    header: { version: VILLAGE_GEOMETRY_VERSION, projection: VILLAGE_PROJECTION_VERSION },
    coords: new Float32Array(coords),
    ringOffsets: new Uint32Array(ringOffsets),
    ringVillageIndices: new Uint32Array(ringVillageIndices),
    ringPolygonIndices: new Uint32Array(ringPolygonIndices),
    ringIsHole: new Uint8Array(ringIsHole),
    villages,
  };
}

/** Merge VILLCODE-ordered geometry parts while preserving each part's ring data. */
export function mergeVillageGeometry(parts: readonly VillageGeometryData[]): VillageGeometryData {
  if (parts.length === 0) throw new Error('At least one village geometry part is required.');
  if (parts.length === 1) return parts[0]!;

  const first = parts[0]!;
  let coordinateOffset = 0;
  let villageOffset = 0;
  let polygonOffset = 0;
  let coordinateLength = 0;
  const ringOffsets: number[] = [0];
  const ringVillageIndices: number[] = [];
  const ringPolygonIndices: number[] = [];
  const ringIsHole: number[] = [];
  const villages: VillageGeometryRecord[] = [];

  for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
    const part = parts[partIndex]!;
    if (part.header.version !== first.header.version || part.header.projection !== first.header.projection) {
      throw new Error('Village geometry headers do not match.');
    }
    if (part.villages.length === 0) throw new Error('Village geometry parts must contain villages.');
    if (partIndex > 0) {
      const previous = parts[partIndex - 1]!.villages;
      const previousCode = previous[previous.length - 1]!.VILLCODE;
      const nextCode = part.villages[0]!.VILLCODE;
      if (compareCode(previousCode, nextCode) >= 0) {
        throw new Error(`Village geometry parts are not strictly ordered: ${previousCode} and ${nextCode}.`);
      }
    }

    for (let index = 1; index < part.ringOffsets.length; index += 1) {
      ringOffsets.push(part.ringOffsets[index]! + coordinateOffset);
    }
    for (const index of part.ringVillageIndices) ringVillageIndices.push(index + villageOffset);
    for (const index of part.ringPolygonIndices) ringPolygonIndices.push(index + polygonOffset);
    for (const isHole of part.ringIsHole) ringIsHole.push(isHole);
    for (const village of part.villages) villages.push(village);

    coordinateOffset += part.coords.length / 2;
    villageOffset += part.villages.length;
    let partPolygonCount = 0;
    for (const index of part.ringPolygonIndices) partPolygonCount = Math.max(partPolygonCount, index + 1);
    polygonOffset += partPolygonCount;
    coordinateLength += part.coords.length;
  }

  const coords = new Float32Array(coordinateLength);
  let coordinatePosition = 0;
  for (const part of parts) {
    coords.set(part.coords, coordinatePosition);
    coordinatePosition += part.coords.length;
  }

  return {
    header: { ...first.header },
    coords,
    ringOffsets: new Uint32Array(ringOffsets),
    ringVillageIndices: new Uint32Array(ringVillageIndices),
    ringPolygonIndices: new Uint32Array(ringPolygonIndices),
    ringIsHole: new Uint8Array(ringIsHole),
    villages,
  };
}
