import { unprojectBBox } from '../map/projection';
import type { BBox } from '../map/types';
import type { VillageGeometryData, VillageGeometryRecord } from '../map/village-geometry';

// 可調：預設都會視圖涵蓋臺北市與新北市六個相鄰核心行政區。
export const TAIPEI_CORE_TOWNCODES = [
  '63000010', '63000020', '63000030', '63000040', '63000050', '63000060',
  '63000070', '63000080', '63000090', '63000100', '63000110', '63000120',
  '65000010', '65000020', '65000030', '65000040', '65000050', '65000140',
] as const;

export interface TownBoundsRecord {
  TOWNCODE: string;
  bbox: BBox;
}

export interface SavedCameraView {
  x: number;
  y: number;
  zoom: number;
}

/** Union the geographic bounds for the listed town codes. */
export function bboxForTowns(records: readonly TownBoundsRecord[], codes: readonly string[]): BBox | undefined {
  const wantedCodes = new Set(codes);
  let bounds: BBox | undefined;
  for (const record of records) {
    if (!wantedCodes.has(record.TOWNCODE)) continue;
    if (!record.bbox.every(Number.isFinite)) continue;
    if (!bounds) {
      bounds = [...record.bbox];
      continue;
    }
    bounds[0] = Math.min(bounds[0], record.bbox[0]);
    bounds[1] = Math.min(bounds[1], record.bbox[1]);
    bounds[2] = Math.max(bounds[2], record.bbox[2]);
    bounds[3] = Math.max(bounds[3], record.bbox[3]);
  }
  return bounds;
}

/**
 * Build geographic village bounds from the worker's projected village geometry.
 * VillageGeometryData stores projected Float32 coordinates to keep transfer buffers compact.
 */
export function villageBoundsFromGeometry(geometry: VillageGeometryData): TownBoundsRecord[] {
  const projectedBounds: Array<BBox | undefined> = geometry.villages.map(() => undefined);
  for (let ringIndex = 0; ringIndex < geometry.ringVillageIndices.length; ringIndex += 1) {
    const villageIndex = geometry.ringVillageIndices[ringIndex]!;
    const start = geometry.ringOffsets[ringIndex]!;
    const end = geometry.ringOffsets[ringIndex + 1]!;
    let bounds = projectedBounds[villageIndex];
    for (let pointIndex = start; pointIndex < end; pointIndex += 1) {
      const x = geometry.coords[pointIndex * 2]!;
      const y = geometry.coords[pointIndex * 2 + 1]!;
      if (!bounds) bounds = [x, y, x, y];
      else {
        bounds[0] = Math.min(bounds[0], x);
        bounds[1] = Math.min(bounds[1], y);
        bounds[2] = Math.max(bounds[2], x);
        bounds[3] = Math.max(bounds[3], y);
      }
    }
    projectedBounds[villageIndex] = bounds;
  }

  const records: TownBoundsRecord[] = [];
  for (let villageIndex = 0; villageIndex < geometry.villages.length; villageIndex += 1) {
    const bounds = projectedBounds[villageIndex];
    const village: VillageGeometryRecord = geometry.villages[villageIndex]!;
    if (bounds) records.push({ TOWNCODE: village.TOWNCODE, bbox: unprojectBBox(bounds) });
  }
  return records;
}

/** A saved metro camera takes precedence; otherwise fit the core, falling back to all towns. */
export function chooseInitialMetroBounds({
  savedCamera,
  core,
  all,
}: {
  savedCamera?: SavedCameraView;
  core?: BBox;
  all: BBox;
}): BBox | undefined {
  if (savedCamera) return undefined;
  return core ?? all;
}
