import { describe, expect, it, vi } from "vitest";
import { importSaveFile, importSaveJson, serializeSave } from "../../src/save/import-export";
import { loadSave, offlineElapsedMs, savePayload } from "../../src/save/save";
import { collectSavePayload, saveCurrentState, type SaveStateProviders } from "../../src/save/state";
import { IndexedDbSaveStorage } from "../../src/save/storage";
import { createEmptyNetwork } from "../../src/city/network";
import { CURRENT_SCHEMA_VERSION, FutureSaveVersionError, MAX_SAVE_BYTES, SaveMigrationError, type SavePayloadV2, type SaveRecord, type SaveStorage } from "../../src/save/types";
import { validateSaveRecord } from "../../src/save/validation";

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
  const validPayload = (): SavePayloadV2 => ({
    network: {
      stations: [
        { id: "s1", name: "A站", lon: 121, lat: 25 },
        { id: "s2", name: "B站", lon: 121.1, lat: 25.1 },
      ],
      lines: [{
        id: "l3", mode: "metro", stationIds: ["s1", "s2"], cars: 3,
        peakTrains: 4, offPeakTrains: 2, color: "#3194d0", name: "M1",
      }],
      nextId: 4,
    },
    camera: { x: 12, y: 30, zoom: 1.5 },
    view: "island",
    simulation: {
      gameTimeMs: 100,
      speed: 2,
      paused: true,
      seed: 123,
      rngState: 456,
      seq: 1,
      routeProgress: 0.25,
    },
    stats: { dailyRidership: 0 },
  });

  it("round-trips a v2 record through the async storage interface", async () => {
    const storage = new MemorySaveStorage();
    const payload = validPayload();
    const written = await savePayload(storage, payload, 1234);
    expect(written).toEqual({ schemaVersion: 2, savedAt: 1234, payload });
    await expect(loadSave(storage)).resolves.toEqual(written);
  });

  it("migrates v1 saves to an empty v2 network and carries the camera", async () => {
    const storage = new MemorySaveStorage();
    storage.value = {
      schemaVersion: 1,
      savedAt: 100,
      payload: { camera: { x: 234, y: 567, zoom: 2 }, simulation: { tick: 12, gameTimeMs: 1_200, running: true } },
    };

    const result = await loadSave(storage);
    expect(result?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(result?.payload.camera).toEqual({ x: 234, y: 567, zoom: 2 });
    expect(result?.payload.network).toEqual(createEmptyNetwork());
    expect(result?.payload.simulation).toMatchObject({ seq: 12, gameTimeMs: 1_200, paused: false, speed: 1 });
    expect(storage.value).toEqual(result);
  });

  it("rejects malformed v2 networks, camera coordinates, and simulation data", () => {
    const record = (payload: SavePayloadV2) => ({ schemaVersion: 2, savedAt: 100, payload });
    const unknownStation = validPayload();
    unknownStation.network.lines[0]!.stationIds[1] = "missing";
    expect(() => importSaveJson(JSON.stringify(record(unknownStation)))).toThrow("未知車站");

    const nanCoordinate = validPayload();
    nanCoordinate.network.stations[0]!.lon = Number.NaN;
    expect(() => validateSaveRecord(record(nanCoordinate))).toThrow("經度無效");

    const invalidCars = validPayload();
    invalidCars.network.lines[0]!.cars = 2;
    expect(() => importSaveJson(JSON.stringify(record(invalidCars)))).toThrow("車節數");

    const invalidCamera = validPayload();
    invalidCamera.camera.x = Number.NaN;
    expect(() => importSaveJson(JSON.stringify(record(invalidCamera)))).toThrow("camera 座標");

    const invalidSimulation = validPayload();
    invalidSimulation.simulation.routeProgress = 1;
    expect(() => importSaveJson(JSON.stringify(record(invalidSimulation)))).toThrow("routeProgress");
  });

  it("saves the current providers and exports the exact saved payload", async () => {
    const storage = new MemorySaveStorage();
    const payload = validPayload();
    const providers: SaveStateProviders = {
      getNetwork: () => payload.network,
      getCamera: () => payload.camera,
      getView: () => payload.view,
      getSimulation: () => payload.simulation,
      getStats: () => payload.stats,
    };
    const current = collectSavePayload(providers);
    const saved = await saveCurrentState(storage, providers, 5678);
    const exported = importSaveJson(serializeSave(saved));
    expect(saved.payload).toEqual(current);
    expect(storage.value).toEqual(saved);
    expect(exported).toEqual(saved);
  });

  it("rejects a future version with a typed error", () => {
    const json = JSON.stringify({ schemaVersion: 3, savedAt: 100, payload: {} });
    expect(() => importSaveJson(json)).toThrow(FutureSaveVersionError);
  });

  it("rejects an older version when no migration has been registered", () => {
    const storage = new MemorySaveStorage();
    storage.value = { schemaVersion: 0, savedAt: 100, payload: {} };
    return expect(loadSave(storage)).rejects.toThrow(SaveMigrationError);
  });

  it("rejects malformed JSON, invalid shape, and oversized imports", () => {
    expect(() => importSaveJson("{" )).toThrow("JSON 格式錯誤");
    expect(() => importSaveJson(JSON.stringify({ schemaVersion: 2, savedAt: "yesterday", payload: {} }))).toThrow("savedAt");
    expect(() => importSaveJson(" ".repeat(MAX_SAVE_BYTES + 1))).toThrow("上限");
  });

  it("imports a valid JSON Blob and enforces the file size limit", async () => {
    const valid = new Blob([serializeSave({ schemaVersion: 2, savedAt: 42, payload: validPayload() })]);
    await expect(importSaveFile(valid)).resolves.toMatchObject({ schemaVersion: 2, savedAt: 42 });
    const oversized = new Blob(["x".repeat(MAX_SAVE_BYTES + 1)]);
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
