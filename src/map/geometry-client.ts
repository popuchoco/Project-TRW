import {
  VILLAGE_GEOMETRY_VERSION,
  VILLAGE_PROJECTION_VERSION,
  type VillageGeometryData,
} from './village-geometry';

type GeometryResponse =
  | { type: 'loaded'; requestId: number; geometry: VillageGeometryData }
  | { type: 'error'; requestId: number; message: string };

interface PendingLoad {
  resolve: (geometry: VillageGeometryData) => void;
  reject: (error: Error) => void;
}

function isGeometryData(value: unknown): value is VillageGeometryData {
  if (typeof value !== 'object' || value === null) return false;
  const geometry = value as Partial<VillageGeometryData>;
  const { header } = geometry;
  if (header?.version !== VILLAGE_GEOMETRY_VERSION
    || header.projection !== VILLAGE_PROJECTION_VERSION
    || !(geometry.coords instanceof Float32Array)
    || !(geometry.ringOffsets instanceof Uint32Array)
    || !(geometry.ringVillageIndices instanceof Uint32Array)
    || !(geometry.ringPolygonIndices instanceof Uint32Array)
    || !(geometry.ringIsHole instanceof Uint8Array)
    || !Array.isArray(geometry.villages)
    || geometry.coords.length % 2 !== 0
    || geometry.ringOffsets.length !== geometry.ringVillageIndices.length + 1
    || geometry.ringPolygonIndices.length !== geometry.ringVillageIndices.length
    || geometry.ringIsHole.length !== geometry.ringVillageIndices.length
    || geometry.ringOffsets[0] !== 0
    || geometry.ringOffsets[geometry.ringOffsets.length - 1] !== geometry.coords.length / 2) return false;

  for (let index = 1; index < geometry.ringOffsets.length; index += 1) {
    if (geometry.ringOffsets[index]! < geometry.ringOffsets[index - 1]!) return false;
  }
  for (let index = 0; index < geometry.ringVillageIndices.length; index += 1) {
    if (geometry.ringVillageIndices[index]! >= geometry.villages.length || geometry.ringIsHole[index]! > 1) return false;
  }
  return geometry.villages.every((village) => typeof village.VILLCODE === 'string'
    && Number.isFinite(village.areaKm2) && village.areaKm2 > 0
    && (village.populationMatched
      ? Number.isFinite(village.densityPerKm2) && village.densityPerKm2! >= 0
      : village.densityPerKm2 === null));
}

/** Thin request client; geometry decoding and projection stay inside the worker. */
export class VillageGeometryClient {
  private nextRequestId = 0;
  private readonly pending = new Map<number, PendingLoad>();

  constructor(
    private readonly worker: Worker = new Worker(new URL('./geometry.worker.ts', import.meta.url), { type: 'module' }),
  ) {
    this.worker.addEventListener('message', this.handleMessage);
    this.worker.addEventListener('error', this.handleWorkerError);
    this.worker.addEventListener('messageerror', this.handleMessageError);
  }

  load(topologyUrl: string, attributesUrl: string): Promise<VillageGeometryData> {
    const requestId = ++this.nextRequestId;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      try {
        this.worker.postMessage({ type: 'load', requestId, topologyUrl, attributesUrl });
      } catch (error) {
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error('Could not request village geometry.'));
      }
    });
  }

  destroy(): void {
    this.worker.removeEventListener('message', this.handleMessage);
    this.worker.removeEventListener('error', this.handleWorkerError);
    this.worker.removeEventListener('messageerror', this.handleMessageError);
    this.worker.terminate();
    this.rejectPending(new Error('Village geometry worker was terminated.'));
  }

  private readonly handleMessage = (event: MessageEvent<GeometryResponse>): void => {
    const message = event.data;
    if (typeof message !== 'object' || message === null || !Number.isSafeInteger(message.requestId)) return;
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    if (message.type === 'error') {
      pending.reject(new Error(message.message));
    } else if (message.type === 'loaded' && isGeometryData(message.geometry)) {
      pending.resolve(message.geometry);
    } else {
      pending.reject(new Error('Village geometry worker returned an invalid buffer or version header.'));
    }
  };

  private readonly handleWorkerError = (event: ErrorEvent): void => {
    this.rejectPending(new Error(event.message || 'Village geometry worker failed.'));
  };

  private readonly handleMessageError = (): void => {
    this.rejectPending(new Error('Could not read the village geometry worker response.'));
  };

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
