import {
  isNonNegativeInteger,
  isTrainCount,
  isValidTransitCars,
  MAX_NAME_LENGTH,
  MAX_TRAINS_PER_PERIOD,
} from "../city/limits";
import { CURRENT_SCHEMA_VERSION, FutureSaveVersionError, SaveValidationError, type SavePayloadV2, type SaveRecord } from "./types";
import { isTransitWorkerSaveState } from "../sim/protocol";

const MAX_STATIONS = 10_000;
const MAX_LINES = 1_000;
const MAX_STATS_FIELDS = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new SaveValidationError(`存檔格式錯誤：${field} 必須是 JSON 物件。`);
  return value;
}

function requireString(value: unknown, field: string, maxLength = 200): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SaveValidationError(`存檔格式錯誤：${field} 必須是有效文字。`);
  }
  if (value.length > maxLength) {
    throw new SaveValidationError(`存檔格式錯誤：${field} 不得超過 ${maxLength} 字。`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, field: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!isNonNegativeInteger(value) || value > maximum) {
    throw new SaveValidationError(`存檔格式錯誤：${field} 必須是有效的非負整數。`);
  }
  return value as number;
}

function validateV2Payload(value: Record<string, unknown>): asserts value is SavePayloadV2 {
  const network = requireRecord(value.network, "payload.network");
  if (!Array.isArray(network.stations) || network.stations.length > MAX_STATIONS) {
    throw new SaveValidationError(`存檔格式錯誤：network.stations 必須是最多 ${MAX_STATIONS} 個車站的陣列。`);
  }
  if (!Array.isArray(network.lines) || network.lines.length > MAX_LINES) {
    throw new SaveValidationError(`存檔格式錯誤：network.lines 必須是最多 ${MAX_LINES} 條路線的陣列。`);
  }

  const stationIds = new Set<string>();
  let highestId = 0;
  for (let index = 0; index < network.stations.length; index += 1) {
    const station = requireRecord(network.stations[index], `network.stations[${index}]`);
    const id = requireString(station.id, `network.stations[${index}].id`, 40);
    const match = /^s([1-9]\d*)$/.exec(id);
    if (!match || stationIds.has(id)) throw new SaveValidationError(`存檔格式錯誤：車站 ID「${id}」無效或重複。`);
    stationIds.add(id);
    highestId = Math.max(highestId, Number(match[1]));
    requireString(station.name, `network.stations[${index}].name`, MAX_NAME_LENGTH);
    if (!isFiniteNumber(station.lon) || station.lon < -180 || station.lon > 180) {
      throw new SaveValidationError(`存檔格式錯誤：車站 ${id} 的經度無效。`);
    }
    if (!isFiniteNumber(station.lat) || station.lat < -90 || station.lat > 90) {
      throw new SaveValidationError(`存檔格式錯誤：車站 ${id} 的緯度無效。`);
    }
    if (station.nameManual !== undefined && typeof station.nameManual !== "boolean") {
      throw new SaveValidationError(`存檔格式錯誤：車站 ${id} 的 nameManual 必須是布林值。`);
    }
  }

  const lineIds = new Set<string>();
  for (let index = 0; index < network.lines.length; index += 1) {
    const line = requireRecord(network.lines[index], `network.lines[${index}]`);
    const id = requireString(line.id, `network.lines[${index}].id`, 40);
    const match = /^l([1-9]\d*)$/.exec(id);
    if (!match || lineIds.has(id)) throw new SaveValidationError(`存檔格式錯誤：路線 ID「${id}」無效或重複。`);
    lineIds.add(id);
    highestId = Math.max(highestId, Number(match[1]));
    if (line.mode !== "brt" && line.mode !== "metro") {
      throw new SaveValidationError(`存檔格式錯誤：路線 ${id} 的運具無效。`);
    }
    if (!Array.isArray(line.stationIds) || line.stationIds.length < 2) {
      throw new SaveValidationError(`存檔格式錯誤：路線 ${id} 至少需要兩個車站。`);
    }
    const servedStationIds = new Set<string>();
    for (const stationId of line.stationIds) {
      if (typeof stationId !== "string" || !stationIds.has(stationId)) {
        throw new SaveValidationError(`存檔格式錯誤：路線 ${id} 含有未知車站 ID。`);
      }
      if (servedStationIds.has(stationId)) {
        throw new SaveValidationError(`存檔格式錯誤：路線 ${id} 重複列出車站 ${stationId}。`);
      }
      servedStationIds.add(stationId);
    }
    if (!isValidTransitCars(line.mode, line.cars)) {
      throw new SaveValidationError(`存檔格式錯誤：路線 ${id} 的車節數超出運具範圍。`);
    }
    if (!isTrainCount(line.peakTrains)) {
      throw new SaveValidationError(`存檔格式錯誤：network.lines[${index}].peakTrains 必須是 ${MAX_TRAINS_PER_PERIOD} 以內的非負整數。`);
    }
    if (!isTrainCount(line.offPeakTrains)) {
      throw new SaveValidationError(`存檔格式錯誤：network.lines[${index}].offPeakTrains 必須是 ${MAX_TRAINS_PER_PERIOD} 以內的非負整數。`);
    }
    requireString(line.name, `network.lines[${index}].name`, MAX_NAME_LENGTH);
    if (typeof line.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(line.color)) {
      throw new SaveValidationError(`存檔格式錯誤：路線 ${id} 的顏色無效。`);
    }
  }

  if (requireNonNegativeInteger(network.nextId, "network.nextId") < highestId + 1) {
    throw new SaveValidationError("存檔格式錯誤：network.nextId 必須大於所有已使用的 ID。");
  }

  const camera = requireRecord(value.camera, "payload.camera");
  if (!isFiniteNumber(camera.x) || !isFiniteNumber(camera.y)) {
    throw new SaveValidationError("存檔格式錯誤：camera 座標必須是有限數值。");
  }
  if (!isFiniteNumber(camera.zoom) || camera.zoom < 0.8 || camera.zoom > 30) {
    throw new SaveValidationError("存檔格式錯誤：camera.zoom 必須介於 0.8 與 30。");
  }

  if (value.view !== "island" && value.view !== "metro") {
    throw new SaveValidationError("存檔格式錯誤：view 必須是 island 或 metro。");
  }

  const simulation = requireRecord(value.simulation, "payload.simulation");
  if (!isFiniteNumber(simulation.gameTimeMs) || simulation.gameTimeMs < 0) {
    throw new SaveValidationError("存檔格式錯誤：simulation.gameTimeMs 必須是非負有限數值。");
  }
  if (simulation.speed !== 1 && simulation.speed !== 2 && simulation.speed !== 4) {
    throw new SaveValidationError("存檔格式錯誤：simulation.speed 必須是 1、2 或 4。");
  }
  if (typeof simulation.paused !== "boolean") {
    throw new SaveValidationError("存檔格式錯誤：simulation.paused 必須是布林值。");
  }
  requireNonNegativeInteger(simulation.seed, "simulation.seed", 0xffff_ffff);
  requireNonNegativeInteger(simulation.rngState, "simulation.rngState", 0xffff_ffff);
  requireNonNegativeInteger(simulation.seq, "simulation.seq");
  if (!isFiniteNumber(simulation.routeProgress) || simulation.routeProgress < 0 || simulation.routeProgress >= 1) {
    throw new SaveValidationError("存檔格式錯誤：simulation.routeProgress 必須介於 0（含）與 1（不含）。");
  }

  const stats = requireRecord(value.stats, "payload.stats");
  const statKeys = Object.keys(stats);
  if (statKeys.length > MAX_STATS_FIELDS) {
    throw new SaveValidationError(`存檔格式錯誤：stats 最多可包含 ${MAX_STATS_FIELDS} 個數值欄位。`);
  }
  for (const key of statKeys) {
    if (key.length > 80 || !isFiniteNumber(stats[key])) {
      throw new SaveValidationError(`存檔格式錯誤：stats.${key} 必須是有限數值。`);
    }
  }

  if (value.transit !== undefined && !isTransitWorkerSaveState(value.transit)) {
    throw new SaveValidationError("存檔格式錯誤：payload.transit 不是有效的模擬延續狀態。");
  }
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
  if (schemaVersion === CURRENT_SCHEMA_VERSION) validateV2Payload(payload);
  return { schemaVersion: schemaVersion as number, savedAt, payload };
}
