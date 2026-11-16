import type { EntityState, SimSnapshot } from './core';

export function interpolateSnapshots(
  previous: SimSnapshot,
  next: SimSnapshot,
  renderTimeMs: number,
): EntityState[] {
  const duration = next.gameTimeMs - previous.gameTimeMs;
  const alpha = duration <= 0 ? 1 : Math.max(0, Math.min(1, (renderTimeMs - previous.gameTimeMs) / duration));
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
