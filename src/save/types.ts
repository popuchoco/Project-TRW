import type { Network } from "../city/network";
import type { RegionId } from "../city/regions";
import type { SimSpeed } from "../sim/clock";
import type { TransitWorkerSaveState } from "../sim/protocol";

export const CURRENT_SCHEMA_VERSION = 2;
export const MAX_SAVE_BYTES = 4 * 1024 * 1024;
export const MAX_OFFLINE_ELAPSED_MS = 8 * 60 * 60 * 1000;

export type SaveView = "island" | "metro";

export interface SaveCamera {
  /** Projected world coordinate at the center of the view. */
  x: number;
  y: number;
  /** Zoom relative to the map's fit scale. */
  zoom: number;
}

export interface SaveSimulationState {
  gameTimeMs: number;
  speed: SimSpeed;
  paused: boolean;
  seed: number;
  rngState: number;
  seq: number;
  routeProgress: number;
}

export interface SavePayloadV2 extends Record<string, unknown> {
  /** Missing means northNorth for legacy saves. */
  region?: RegionId;
  network: Network;
  camera: SaveCamera;
  view: SaveView;
  simulation: SaveSimulationState;
  /** Small numeric summary fields supplied by the active simulation. */
  stats: Record<string, number>;
  /** Resumable transit model state, including habit history and daily summaries. */
  transit?: TransitWorkerSaveState;
}

export interface SaveRecord {
  schemaVersion: number;
  savedAt: number;
  payload: Record<string, unknown>;
}

export interface SaveStorage {
  read(): Promise<unknown | undefined>;
  write(record: SaveRecord): Promise<void>;
}

export class SaveValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SaveValidationError";
  }
}

export class FutureSaveVersionError extends SaveValidationError {
  constructor(version: number, supportedVersion: number) {
    super(`存檔版本 ${version} 高於目前支援版本 ${supportedVersion}。`);
    this.name = "FutureSaveVersionError";
  }
}

export class SaveMigrationError extends SaveValidationError {
  constructor(version: number) {
    super(`找不到存檔版本 ${version} 的遷移步驟。`);
    this.name = "SaveMigrationError";
  }
}
