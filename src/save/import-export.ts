import { migrate, type MigrationRegistry } from "./migrations";
import { CURRENT_SCHEMA_VERSION, MAX_SAVE_BYTES, type SaveRecord } from "./types";
import { validateSaveRecord } from "./validation";

export function serializeSave(record: SaveRecord): string {
  return JSON.stringify(validateSaveRecord(record), null, 2);
}

export function importSaveJson(text: string, registry?: MigrationRegistry): SaveRecord {
  const byteLength = new TextEncoder().encode(text).byteLength;
  if (byteLength > MAX_SAVE_BYTES) throw new Error(`存檔超過 ${MAX_SAVE_BYTES / 1024 / 1024} MiB 上限。`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("無法讀取存檔：JSON 格式錯誤。");
  }
  const record = validateSaveRecord(parsed);
  return registry
    ? migrate(record, CURRENT_SCHEMA_VERSION, registry)
    : migrate(record);
}

export async function importSaveFile(file: Blob, registry?: MigrationRegistry): Promise<SaveRecord> {
  if (file.size > MAX_SAVE_BYTES) throw new Error(`存檔超過 ${MAX_SAVE_BYTES / 1024 / 1024} MiB 上限。`);
  return importSaveJson(await file.text(), registry);
}

export function triggerSaveDownload(record: SaveRecord): void {
  const blob = new Blob([serializeSave(record)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "project-trw-save.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
