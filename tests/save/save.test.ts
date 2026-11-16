import { describe, expect, it, vi } from "vitest";
import { importSaveFile, importSaveJson } from "../../src/save/import-export";
import { MigrationRegistry } from "../../src/save/migrations";
import { loadSave, offlineElapsedMs, savePayload } from "../../src/save/save";
import { IndexedDbSaveStorage } from "../../src/save/storage";
import { CURRENT_SCHEMA_VERSION, FutureSaveVersionError, SaveMigrationError, type SaveRecord, type SaveStorage } from "../../src/save/types";

class MemorySaveStorage implements SaveStorage {
  value: unknown | undefined;

  async read(): Promise<unknown | undefined> {
    return this.value;
  }

  async write(record: SaveRecord): Promise<void> {
    this.value = record;
  }
}

describe("save records", () => {
  it("writes and reads through the async storage interface", async () => {
    const storage = new MemorySaveStorage();
    const written = await savePayload(storage, { camera: { x: 12, y: 30 } }, 1234);
    expect(written).toEqual({ schemaVersion: CURRENT_SCHEMA_VERSION, savedAt: 1234, payload: { camera: { x: 12, y: 30 } } });
    await expect(loadSave(storage)).resolves.toEqual(written);
  });

  it("runs a registered migration from a synthetic older record", async () => {
    const storage = new MemorySaveStorage();
    storage.value = { schemaVersion: 0, savedAt: 100, payload: { x: 2 } };
    const registry = new MigrationRegistry();
    registry.register(0, 1, (record) => ({
      ...record,
      schemaVersion: 1,
      payload: { camera: { x: record.payload.x, y: 0 }, simulation: { tick: 0, running: false } },
    }));

    const result = await loadSave(storage, registry);
    expect(result?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(result?.payload.camera).toEqual({ x: 2, y: 0 });
    expect(storage.value).toEqual(result);
  });

  it("rejects a future version with a typed error", () => {
    const json = JSON.stringify({ schemaVersion: 2, savedAt: 100, payload: {} });
    expect(() => importSaveJson(json)).toThrow(FutureSaveVersionError);
  });

  it("rejects an older version when no migration has been registered", () => {
    const storage = new MemorySaveStorage();
    storage.value = { schemaVersion: 0, savedAt: 100, payload: {} };
    return expect(loadSave(storage)).rejects.toThrow(SaveMigrationError);
  });

  it("rejects malformed JSON, invalid shape, and oversized imports", () => {
    expect(() => importSaveJson("{" )).toThrow("JSON 格式錯誤");
    expect(() => importSaveJson(JSON.stringify({ schemaVersion: 1, savedAt: "yesterday", payload: {} }))).toThrow("savedAt");
    expect(() => importSaveJson(" ".repeat(1024 * 1024 + 1))).toThrow("上限");
  });

  it("imports a valid JSON Blob and enforces the file size limit", async () => {
    const valid = new Blob([JSON.stringify({ schemaVersion: 1, savedAt: 42, payload: { camera: {} } })]);
    await expect(importSaveFile(valid)).resolves.toMatchObject({ schemaVersion: 1, savedAt: 42 });
    const oversized = new Blob(["x".repeat(1024 * 1024 + 1)]);
    await expect(importSaveFile(oversized)).rejects.toThrow("上限");
  });
});

describe("offline elapsed time", () => {
  const hour = 60 * 60 * 1000;

  it("clamps negative elapsed time to zero", () => expect(offlineElapsedMs(10, 11)).toBe(0));
  it("returns zero when timestamps match", () => expect(offlineElapsedMs(10, 10)).toBe(0));
  it("preserves 7.9 hours", () => expect(offlineElapsedMs(7.9 * hour, 0)).toBe(7.9 * hour));
  it("preserves exactly eight hours", () => expect(offlineElapsedMs(8 * hour, 0)).toBe(8 * hour));
  it("caps thirty hours at eight hours", () => expect(offlineElapsedMs(30 * hour, 0)).toBe(8 * hour));
});

describe("IndexedDB save storage open lifecycle", () => {
  function makeOpenRequest(database: IDBDatabase): IDBOpenDBRequest {
    return { result: database, error: null } as unknown as IDBOpenDBRequest;
  }

  function storageWithRequests(requests: IDBOpenDBRequest[]): IndexedDbSaveStorage {
    const factory = {
      open: () => {
        const database = { onversionchange: null, close: vi.fn() } as unknown as IDBDatabase;
        const request = makeOpenRequest(database);
        requests.push(request);
        return request;
      },
    } as unknown as IDBFactory;
    return new IndexedDbSaveStorage(factory);
  }

  function open(storage: IndexedDbSaveStorage): Promise<IDBDatabase> {
    return (storage as unknown as { open(): Promise<IDBDatabase> }).open();
  }

  it("clears a failed open promise so a later call retries", async () => {
    const requests: IDBOpenDBRequest[] = [];
    const storage = storageWithRequests(requests);
    const first = open(storage);
    requests[0]!.onerror?.(new Event("error"));
    await expect(first).rejects.toThrow("Unable to open save database");

    const second = open(storage);
    expect(requests).toHaveLength(2);
    requests[1]!.onsuccess?.(new Event("success"));
    await expect(second).resolves.toBe(requests[1]!.result);
  });

  it("waits through blocked upgrades and closes on version change", async () => {
    const requests: IDBOpenDBRequest[] = [];
    const storage = storageWithRequests(requests);
    const pending = open(storage);
    requests[0]!.onblocked?.(new Event("blocked") as IDBVersionChangeEvent);
    const status = await Promise.race([pending.then(() => "settled", () => "settled"), Promise.resolve("pending")]);
    expect(status).toBe("pending");

    requests[0]!.onsuccess?.(new Event("success"));
    const database = await pending;
    database.onversionchange?.(new Event("versionchange") as IDBVersionChangeEvent);
    expect((database.close as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();

    const reopened = open(storage);
    expect(requests).toHaveLength(2);
    requests[1]!.onsuccess?.(new Event("success"));
    await expect(reopened).resolves.toBe(requests[1]!.result);
  });
});
