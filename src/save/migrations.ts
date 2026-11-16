import { CURRENT_SCHEMA_VERSION, FutureSaveVersionError, SaveMigrationError, type SaveRecord } from "./types";
import { validateSaveRecord } from "./validation";
import { createEmptyNetwork } from "../city/network";
import { FIXED_TICK_MS } from "../sim/clock";
import { createSim } from "../sim/core";

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

const LEGACY_SIMULATION_SEED = 0x545257;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

saveMigrations.register(1, 2, (record) => {
  const legacySimulation = isRecord(record.payload.simulation) ? record.payload.simulation : {};
  const seq = Number.isSafeInteger(legacySimulation.tick) && (legacySimulation.tick as number) >= 0
    ? legacySimulation.tick as number
    : 0;
  const gameTimeMs = typeof legacySimulation.gameTimeMs === "number" && Number.isFinite(legacySimulation.gameTimeMs)
    && legacySimulation.gameTimeMs >= 0
    ? legacySimulation.gameTimeMs
    : seq * FIXED_TICK_MS;
  const initialSimulation = createSim(LEGACY_SIMULATION_SEED);
  const routeProgress = ((initialSimulation.routeProgress + seq * 0.0008) % 1 + 1) % 1;
  return {
    ...record,
    schemaVersion: 2,
    payload: {
      network: createEmptyNetwork(),
      camera: record.payload.camera ?? { x: 0, y: 0, zoom: 1 },
      view: "island",
      simulation: {
        gameTimeMs,
        speed: 1,
        paused: legacySimulation.running !== true,
        seed: initialSimulation.seed,
        rngState: initialSimulation.rngState,
        seq,
        routeProgress,
      },
      stats: {},
    },
  };
});

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
