export const CURRENT_SCHEMA_VERSION = 1;
export const MAX_SAVE_BYTES = 1024 * 1024;
export const MAX_OFFLINE_ELAPSED_MS = 8 * 60 * 60 * 1000;

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
