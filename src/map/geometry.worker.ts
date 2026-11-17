import { decodeVillageGeometry, type VillageGeometryAttribute, type VillageGeometryData } from './village-geometry';
import type { Topology } from './types';

interface GeometryRequest {
  type: 'load';
  requestId: number;
  topologyUrl: string;
  attributesUrl: string;
}

type GeometryResponse =
  | { type: 'loaded'; requestId: number; geometry: VillageGeometryData }
  | { type: 'error'; requestId: number; message: string };

interface GeometryWorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: GeometryResponse, transfer?: Transferable[]): void;
}

function isGeometryRequest(value: unknown): value is GeometryRequest {
  if (typeof value !== 'object' || value === null) return false;
  const request = value as Record<string, unknown>;
  return request.type === 'load'
    && Number.isSafeInteger(request.requestId)
    && typeof request.topologyUrl === 'string'
    && typeof request.attributesUrl === 'string';
}

async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Village geometry request failed (${response.status}): ${url}`);
  return await response.json() as T;
}

const workerScope = globalThis as unknown as GeometryWorkerScope;

workerScope.onmessage = (event: MessageEvent<unknown>): void => {
  if (!isGeometryRequest(event.data)) return;
  const { requestId, topologyUrl, attributesUrl } = event.data;
  void Promise.all([
    readJson<Topology>(topologyUrl),
    readJson<VillageGeometryAttribute[]>(attributesUrl),
  ]).then(([topology, attributes]) => {
    const geometry = decodeVillageGeometry(topology, attributes);
    workerScope.postMessage({ type: 'loaded', requestId, geometry }, [
      geometry.coords.buffer as ArrayBuffer,
      geometry.ringOffsets.buffer as ArrayBuffer,
      geometry.ringVillageIndices.buffer as ArrayBuffer,
      geometry.ringPolygonIndices.buffer as ArrayBuffer,
      geometry.ringIsHole.buffer as ArrayBuffer,
    ]);
  }).catch((error: unknown) => {
    workerScope.postMessage({
      type: 'error',
      requestId,
      message: error instanceof Error ? error.message : 'Village geometry worker failed.',
    });
  });
};
