import { CURRENT_SCHEMA_VERSION, FutureSaveVersionError, SaveValidationError, type SaveRecord } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

export function validateSaveRecord(value: unknown): SaveRecord {
  if (!isRecord(value)) throw new SaveValidationError("存檔格式錯誤：最外層必須是 JSON 物件。");
  const { schemaVersion, savedAt, payload } = value;
  if (!Number.isSafeInteger(schemaVersion) || (schemaVersion as number) < 0) {
    throw new SaveValidationError("存檔格式錯誤：schemaVersion 必須是非負整數。");
  }
  if (typeof savedAt !== "number" || !Number.isFinite(savedAt) || savedAt < 0) {
    throw new SaveValidationError("存檔格式錯誤：savedAt 必須是非負 epoch 毫秒。");
  }
  if (!isRecord(payload)) throw new SaveValidationError("存檔格式錯誤：payload 必須是 JSON 物件。");
  if ((schemaVersion as number) > CURRENT_SCHEMA_VERSION) {
    throw new FutureSaveVersionError(schemaVersion as number, CURRENT_SCHEMA_VERSION);
  }
  return { schemaVersion: schemaVersion as number, savedAt, payload };
}
