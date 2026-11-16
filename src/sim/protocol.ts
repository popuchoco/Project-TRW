import { SIM_SPEEDS, type SimSpeed } from './clock';
import type { SimContinuationState, SimSnapshot } from './core';

export type MainToWorkerMessage =
  | { type: 'start'; seed: number; state?: SimContinuationState; paused?: boolean; speed?: SimSpeed }
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
  if (message.type === 'start') {
    if (!Number.isSafeInteger(message.seed) || (message.seed as number) < 0 || (message.seed as number) > 0xffff_ffff) return false;
    if (message.paused !== undefined && typeof message.paused !== 'boolean') return false;
    if (message.speed !== undefined && !SIM_SPEEDS.includes(message.speed as SimSpeed)) return false;
    if (message.state === undefined) return true;
    if (typeof message.state !== 'object' || message.state === null) return false;
    const state = message.state as Record<string, unknown>;
    return state.seed === message.seed && Number.isSafeInteger(state.rngState) && (state.rngState as number) >= 0 &&
      (state.rngState as number) <= 0xffff_ffff && Number.isSafeInteger(state.seq) && (state.seq as number) >= 0 &&
      Number.isFinite(state.gameTimeMs) && (state.gameTimeMs as number) >= 0 &&
      Number.isFinite(state.routeProgress) && (state.routeProgress as number) >= 0 && (state.routeProgress as number) < 1;
  }
  if (message.type === 'pause' || message.type === 'resume') return true;
  return message.type === 'setSpeed' && SIM_SPEEDS.includes(message.speed as SimSpeed);
}

export function isWorkerToMainMessage(value: unknown): value is WorkerToMainMessage {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false;
  const message = value as Record<string, unknown>;
  if (message.type !== 'snapshot' || typeof message.snapshot !== 'object' || message.snapshot === null) return false;
  const snapshot = message.snapshot as Record<string, unknown>;
  if (!Number.isSafeInteger(snapshot.seq) || (snapshot.seq as number) < 0 ||
      !Number.isFinite(snapshot.gameTimeMs) || (snapshot.gameTimeMs as number) < 0 ||
      !Number.isSafeInteger(snapshot.seed) || (snapshot.seed as number) < 0 || (snapshot.seed as number) > 0xffff_ffff ||
      !Number.isSafeInteger(snapshot.rngState) || (snapshot.rngState as number) < 0 || (snapshot.rngState as number) > 0xffff_ffff ||
      !Number.isFinite(snapshot.routeProgress) || (snapshot.routeProgress as number) < 0 ||
      (snapshot.routeProgress as number) >= 1 || !Array.isArray(snapshot.entities)) return false;
  return snapshot.entities.every((entity: unknown) => {
    if (typeof entity !== 'object' || entity === null) return false;
    const item = entity as Record<string, unknown>;
    return typeof item.id === 'string' && Number.isFinite(item.lon) && Number.isFinite(item.lat);
  });
}
