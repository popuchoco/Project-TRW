import { project } from './projection';
import { decodeTopology } from './topology';
import type { MultiPolygonGeometry, Position, Topology } from './types';

export const VILLAGE_GEOMETRY_VERSION = 1 as const;
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
  villages: VillageGeometryAttribute[];
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

/** Decode village TopoJSON and encode projected rings with attribute indices. */
export function decodeVillageGeometry(
  topology: Topology,
  sourceAttributes: readonly VillageGeometryAttribute[],
): VillageGeometryData {
  const features = decodeTopology(topology, 'north-north-simplified') as unknown as VillageTopologyFeature[];
  const villages = sourceAttributes.map(copyAndValidateAttribute).sort((a, b) => compareCode(a.VILLCODE, b.VILLCODE));
  for (let index = 1; index < villages.length; index += 1) {
    if (villages[index - 1]!.VILLCODE === villages[index]!.VILLCODE) {
      throw new Error(`Village attributes contain a duplicate VILLCODE: ${villages[index]!.VILLCODE}`);
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
  if (featuresByCode.size !== villages.length) {
    throw new Error(`Village topology and attribute counts do not match (${featuresByCode.size} and ${villages.length}).`);
  }

  const coords: number[] = [];
  const ringOffsets: number[] = [0];
  const ringVillageIndices: number[] = [];
  const ringPolygonIndices: number[] = [];
  const ringIsHole: number[] = [];
  let polygonIndex = 0;

  for (let villageIndex = 0; villageIndex < villages.length; villageIndex += 1) {
    const village = villages[villageIndex]!;
    const feature = featuresByCode.get(village.VILLCODE);
    if (!feature) throw new Error(`Village topology is missing ${village.VILLCODE}.`);

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
