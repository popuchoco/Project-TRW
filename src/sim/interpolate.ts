import type { EntityState, SimSnapshot } from './core';
import type { TrainPosition, TransitWorkerSnapshot } from './protocol';

function interpolationAmount(previousTime: number, nextTime: number, renderTimeMs: number): number {
  const duration = nextTime - previousTime;
  return duration <= 0 ? 1 : Math.max(0, Math.min(1, (renderTimeMs - previousTime) / duration));
}

/** Compatibility interpolation for the original P0 dummy entity snapshots. */
export function interpolateSnapshots(
  previous: SimSnapshot,
  next: SimSnapshot,
  renderTimeMs: number,
): EntityState[] {
  const alpha = interpolationAmount(previous.gameTimeMs, next.gameTimeMs, renderTimeMs);
  const previousById = new Map(previous.entities.map((entity) => [entity.id, entity]));
  return next.entities.map((entity) => {
    const start = previousById.get(entity.id);
    if (!start) return { ...entity };
    return {
      id: entity.id,
      lon: start.lon + (entity.lon - start.lon) * alpha,
      lat: start.lat + (entity.lat - start.lat) * alpha,
    };
  });
}

/** Interpolates train positions between deterministic worker snapshots. */
export function interpolateTrainSnapshots(
  previous: TransitWorkerSnapshot,
  next: TransitWorkerSnapshot,
  renderTimeMs: number,
): TrainPosition[] {
  const alpha = interpolationAmount(previous.gameTimeMs, next.gameTimeMs, renderTimeMs);
  const previousById = new Map(previous.trains.map((train) => [train.id, train]));
  return next.trains.map((train) => {
    const start = previousById.get(train.id);
    if (!start) return { ...train };
    return {
      id: train.id,
      lineId: train.lineId,
      lon: start.lon + (train.lon - start.lon) * alpha,
      lat: start.lat + (train.lat - start.lat) * alpha,
    };
  });
}
