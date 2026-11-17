import { QuadTree } from './quadtree';
import { project } from './projection';
import type { BBox } from './types';
import type { VillageGeometryData, VillageGeometryRecord } from './village-geometry';

interface VillageRingRef {
  index: number;
}

interface VillagePolygonRef {
  rings: VillageRingRef[];
  bbox: BBox;
}

interface VillageHitRecord {
  villageIndex: number;
  polygons: VillagePolygonRef[];
  bbox: BBox;
}

function pointInRing(geometry: VillageGeometryData, ringIndex: number, x: number, y: number): boolean {
  const start = geometry.ringOffsets[ringIndex]!;
  const end = geometry.ringOffsets[ringIndex + 1]!;
  let inside = false;
  for (let index = start, previous = end - 1; index < end; previous = index, index += 1) {
    const x1 = geometry.coords[previous * 2]!;
    const y1 = geometry.coords[previous * 2 + 1]!;
    const x2 = geometry.coords[index * 2]!;
    const y2 = geometry.coords[index * 2 + 1]!;
    const cross = (x - x1) * (y2 - y1) - (y - y1) * (x2 - x1);
    const dot = (x - x1) * (x - x2) + (y - y1) * (y - y2);
    if (Math.abs(cross) <= 1e-10 && dot <= 1e-10) return true;
    if ((y1 > y) !== (y2 > y) && x < ((x2 - x1) * (y - y1)) / (y2 - y1) + x1) inside = !inside;
  }
  return inside;
}

/** Spatial lookup over the projected, worker-decoded village buffers. */
export class VillageGeometryLookup {
  private readonly index: QuadTree<VillageHitRecord>;

  constructor(private readonly geometry: VillageGeometryData) {
    const polygonGroups = geometry.villages.map(() => new Map<number, number[]>());
    for (let ringIndex = 0; ringIndex < geometry.ringVillageIndices.length; ringIndex += 1) {
      const villageIndex = geometry.ringVillageIndices[ringIndex]!;
      const polygonIndex = geometry.ringPolygonIndices[ringIndex]!;
      const rings = polygonGroups[villageIndex]?.get(polygonIndex) ?? [];
      rings.push(ringIndex);
      polygonGroups[villageIndex]?.set(polygonIndex, rings);
    }

    const records = polygonGroups.map((group, villageIndex): VillageHitRecord => {
      const polygons = [...group.values()].map((ringIndexes): VillagePolygonRef => {
        const rings = ringIndexes.map((index) => ({ index }));
        const bbox: BBox = [Infinity, Infinity, -Infinity, -Infinity];
        for (const { index } of rings) {
          const start = geometry.ringOffsets[index]!;
          const end = geometry.ringOffsets[index + 1]!;
          for (let pointIndex = start; pointIndex < end; pointIndex += 1) {
            const x = geometry.coords[pointIndex * 2]!;
            const y = geometry.coords[pointIndex * 2 + 1]!;
            bbox[0] = Math.min(bbox[0], x);
            bbox[1] = Math.min(bbox[1], y);
            bbox[2] = Math.max(bbox[2], x);
            bbox[3] = Math.max(bbox[3], y);
          }
        }
        return { rings, bbox };
      });
      const bbox: BBox = [Infinity, Infinity, -Infinity, -Infinity];
      for (const polygon of polygons) {
        bbox[0] = Math.min(bbox[0], polygon.bbox[0]);
        bbox[1] = Math.min(bbox[1], polygon.bbox[1]);
        bbox[2] = Math.max(bbox[2], polygon.bbox[2]);
        bbox[3] = Math.max(bbox[3], polygon.bbox[3]);
      }
      return { villageIndex, polygons, bbox };
    }).filter(({ polygons }) => polygons.length > 0);
    this.index = new QuadTree(records, ({ bbox }) => bbox);
  }

  findProjected(x: number, y: number): VillageGeometryRecord | undefined {
    for (const record of this.index.queryPoint(x, y)) {
      const inside = record.polygons.some((polygon) => {
        let containsPoint = false;
        for (const ring of polygon.rings) {
          if (pointInRing(this.geometry, ring.index, x, y)) containsPoint = !containsPoint;
        }
        return containsPoint;
      });
      if (inside) return this.geometry.villages[record.villageIndex];
    }
    return undefined;
  }

  find(lon: number, lat: number): VillageGeometryRecord | undefined {
    const point = project([lon, lat]);
    return this.findProjected(point.x, point.y);
  }
}
