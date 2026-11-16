import { CURRENT_SCHEMA_VERSION, FutureSaveVersionError, SaveMigrationError, type SaveRecord } from "./types";
import { validateSaveRecord } from "./validation";

export type SaveMigration = (record: SaveRecord) => SaveRecord;

export class MigrationRegistry {
  private readonly steps = new Map<number, { to: number; migrate: SaveMigration }>();

  register(from: number, to: number, migrate: SaveMigration): void {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to !== from + 1) {
      throw new Error("Save migrations must move between adjacent integer schema versions.");
    }
    this.steps.set(from, { to, migrate });
  }

  get(from: number): { to: number; migrate: SaveMigration } | undefined {
    return this.steps.get(from);
  }
}

export const saveMigrations = new MigrationRegistry();

export function migrate(recordValue: unknown, to = CURRENT_SCHEMA_VERSION, registry = saveMigrations): SaveRecord {
  let record = validateSaveRecord(recordValue);
  if (!Number.isSafeInteger(to) || to < 0) throw new Error("Target save version must be a non-negative integer.");
  if (record.schemaVersion > to) throw new FutureSaveVersionError(record.schemaVersion, to);

  while (record.schemaVersion < to) {
    const step = registry.get(record.schemaVersion);
    if (!step) throw new SaveMigrationError(record.schemaVersion);
    const migrated = validateSaveRecord(step.migrate(record));
    if (migrated.schemaVersion !== step.to) {
      throw new Error(`Migration ${record.schemaVersion} -> ${step.to} returned schema ${migrated.schemaVersion}.`);
    }
    record = migrated;
  }
  return record;
}
