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

/** Run once when the browser is idle, or when the caller triggers the work first. */
export function scheduleOnceOnIdleOrTrigger(callback: () => void): () => void {
  let pending = true;
  let idleHandle: number | undefined;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const run = (): void => {
    if (!pending) return;
    pending = false;
    if (idleHandle !== undefined && typeof window !== 'undefined' && typeof window.cancelIdleCallback === 'function') {
      window.cancelIdleCallback(idleHandle);
    }
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    callback();
  };

  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    idleHandle = window.requestIdleCallback(run);
  } else {
    timeoutHandle = setTimeout(run, 1500);
  }

  return run;
}
