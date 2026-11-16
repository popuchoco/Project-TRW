import { migrate, type MigrationRegistry } from "./migrations";
import { CURRENT_SCHEMA_VERSION, MAX_OFFLINE_ELAPSED_MS, type SaveRecord, type SaveStorage } from "./types";
import { validateSaveRecord } from "./validation";

export async function savePayload(storage: SaveStorage, payload: Record<string, unknown>, savedAt = Date.now()): Promise<SaveRecord> {
  const record = validateSaveRecord({ schemaVersion: CURRENT_SCHEMA_VERSION, savedAt, payload });
  await storage.write(record);
  return record;
}

export async function loadSave(storage: SaveStorage, registry?: MigrationRegistry): Promise<SaveRecord | undefined> {
  const raw = await storage.read();
  if (raw === undefined) return undefined;
  const original = validateSaveRecord(raw);
  const current = registry ? migrate(original, CURRENT_SCHEMA_VERSION, registry) : migrate(original);
  if (current.schemaVersion !== original.schemaVersion) await storage.write(current);
  return current;
}

export function offlineElapsedMs(now: number, savedAt: number): number {
  if (!Number.isFinite(now) || !Number.isFinite(savedAt)) return 0;
  return Math.min(Math.max(now - savedAt, 0), MAX_OFFLINE_ELAPSED_MS);
}
