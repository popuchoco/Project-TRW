export type LodId = 'lod0' | 'lod1' | 'lod2' | 'lod3';

/** Zoom multipliers relative to the initial full-island fit scale. */
export const LOD_THRESHOLDS = {
  lod1: 1.35,
  lod2: 2.8,
  lod3: 6,
} as const;

export function chooseLod(zoom: number): LodId {
  if (zoom >= LOD_THRESHOLDS.lod3) return 'lod3';
  if (zoom >= LOD_THRESHOLDS.lod2) return 'lod2';
  if (zoom >= LOD_THRESHOLDS.lod1) return 'lod1';
  return 'lod0';
}
