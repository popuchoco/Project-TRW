import { SIM_SPEEDS, type SimSpeed } from './clock';
import type { SimSnapshot } from './core';

export type MainToWorkerMessage =
  | { type: 'start'; seed: number }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'setSpeed'; speed: SimSpeed };

export interface WorkerToMainMessage {
  type: 'snapshot';
  snapshot: SimSnapshot;
}

export function isMainToWorkerMessage(value: unknown): value is MainToWorkerMessage {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false;
  const message = value as Record<string, unknown>;
  if (message.type === 'start') return Number.isSafeInteger(message.seed);
  if (message.type === 'pause' || message.type === 'resume') return true;
  return message.type === 'setSpeed' && SIM_SPEEDS.includes(message.speed as SimSpeed);
}

export function isWorkerToMainMessage(value: unknown): value is WorkerToMainMessage {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false;
  const message = value as Record<string, unknown>;
  if (message.type !== 'snapshot' || typeof message.snapshot !== 'object' || message.snapshot === null) return false;
  const snapshot = message.snapshot as Record<string, unknown>;
  if (!Number.isSafeInteger(snapshot.seq) || !Number.isFinite(snapshot.gameTimeMs) || !Array.isArray(snapshot.entities)) return false;
  return snapshot.entities.every((entity: unknown) => {
    if (typeof entity !== 'object' || entity === null) return false;
    const item = entity as Record<string, unknown>;
    return typeof item.id === 'string' && Number.isFinite(item.lon) && Number.isFinite(item.lat);
  });
}
