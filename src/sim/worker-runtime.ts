import {
  haversineKm,
  lineRoundTripTimeSeconds,
  trainsForPeriod,
  type Line,
  type Network,
  type Station,
} from '../city/network';
import { isNonNegativeInteger } from '../city/limits';
import { GAME_DAY_MS } from '../city/modes';
import { createSim, resumeSim, snapshotOf, step, type SimState } from './core';
import type { SimSpeed } from './clock';
import { GAME_MS_PER_SIM_TICK } from './time';
import {
  isMainToWorkerMessage,
  isTransitMainToWorkerMessage,
  type MainToWorkerMessage,
  type LineFlowsMessage,
  type TransitMainToWorkerMessage,
  type TransitWorkerSaveState,
  type TransitWorkerSnapshot,
  type TransitWorkerToMainMessage,
  type TrainPosition,
  type VillageAttribute,
  type VillageSource,
  type WorkerToMainMessage,
} from './protocol';
import { TransitSim } from './transit';
import type { VillageDemandPoint } from './transit/demand';

export const MAX_VISIBLE_TRAINS = 300;

export type WorkerRuntimeOutput = WorkerToMainMessage | TransitWorkerToMainMessage;

type LoadVillages = (source: VillageSource) => Promise<VillageDemandPoint[]>;

/** Testable message handler. All simulation state and transitions live here, never in the worker shell. */
export class TransitWorkerRuntime {
  private simulation?: TransitSim;
  private legacyState?: SimState;
  private villages: VillageDemandPoint[] = [];
  private seed = 0;
  private sequence = 0;
  private paused = true;
  private currentSpeed: SimSpeed = 1;
  private networkVersion = 0;
  private lastSentLineFlows?: Pick<LineFlowsMessage, 'gameDay' | 'periodId' | 'networkVersion'>;

  constructor(private readonly loadVillages: LoadVillages = loadVillageSource) {}

  get started(): boolean {
    return this.simulation !== undefined || this.legacyState !== undefined;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  get speed(): SimSpeed {
    return this.currentSpeed;
  }

  async handle(value: unknown): Promise<WorkerRuntimeOutput[]> {
    if (isTransitMainToWorkerMessage(value)) return this.handleTransitMessage(value);
    if (isMainToWorkerMessage(value)) return this.handleLegacyMessage(value);
    return [];
  }

  /** Advances exactly one game minute (or one legacy P0 tick) when running. */
  advanceTick(): WorkerRuntimeOutput[] {
    if (this.paused) return [];
    if (this.simulation) {
      this.simulation.advance(GAME_MS_PER_SIM_TICK);
      this.sequence += 1;
      const snapshotMessage = this.transitSnapshot();
      const snapshot = snapshotMessage.snapshot;
      const outputs: WorkerRuntimeOutput[] = [snapshotMessage];
      if (!this.lastSentLineFlows
        || this.lastSentLineFlows.gameDay !== snapshot.gameDay
        || this.lastSentLineFlows.periodId !== snapshot.currentPeriodId
        || this.lastSentLineFlows.networkVersion !== this.networkVersion) {
        outputs.push(this.unsolicitedLineFlows());
      }
      return outputs;
    }
    if (this.legacyState) {
      this.legacyState = step(this.legacyState);
      return [{ type: 'snapshot', snapshot: snapshotOf(this.legacyState) }];
    }
    return [];
  }

  private async handleTransitMessage(message: TransitMainToWorkerMessage): Promise<WorkerRuntimeOutput[]> {
    if (message.type === 'start') return this.startTransit(message);
    if (message.type === 'pause') {
      this.paused = true;
      return [];
    }
    if (message.type === 'resume') {
      this.paused = false;
      return [];
    }
    if (message.type === 'setSpeed') {
      this.currentSpeed = message.speed;
      return [];
    }
    if (message.type === 'setNetwork') {
      if (!this.simulation) return [];
      this.simulation.setNetwork(message.network);
      this.simulation.refresh();
      this.bumpNetworkVersion();
      return [this.transitSnapshot(), this.unsolicitedLineFlows()];
    }
    if (message.type === 'requestLineFlows') {
      return [this.requestedLineFlows(message.requestId, message.lineId)];
    }
    if (message.type === 'saveState') {
      if (!this.simulation) {
        return [{ type: 'error', requestId: message.requestId, message: 'Simulation has not started.' }];
      }
      const state: TransitWorkerSaveState = { version: 2, seed: this.seed, transit: this.simulation.serialize() };
      return [{ type: 'saveStateResult', requestId: message.requestId, state }];
    }
    if (message.type === 'requestRepresentativePassenger') {
      return [{
        type: 'representativePassengerResult',
        requestId: message.requestId,
        passenger: this.simulation?.representativePassenger(message.stationId) ?? null,
      }];
    }
    return this.loadTransitState(message.requestId, message.state);
  }

  private handleLegacyMessage(message: MainToWorkerMessage): WorkerRuntimeOutput[] {
    if (message.type === 'start') {
      this.simulation = undefined;
      this.legacyState = message.state ? resumeSim(message.state) : createSim(message.seed);
      this.seed = this.legacyState.seed;
      this.sequence = this.legacyState.seq;
      this.currentSpeed = message.speed ?? 1;
      this.paused = message.paused ?? false;
      return [{ type: 'snapshot', snapshot: snapshotOf(this.legacyState) }];
    }
    if (message.type === 'pause') this.paused = true;
    else if (message.type === 'resume') this.paused = false;
    else this.currentSpeed = message.speed;
    return [];
  }

  private async startTransit(
    message: Extract<TransitMainToWorkerMessage, { type: 'start' }>,
  ): Promise<WorkerRuntimeOutput[]> {
    this.legacyState = undefined;
    this.villages = await this.loadVillages(message.villages);
    this.seed = message.state?.seed ?? message.seed;
    this.currentSpeed = message.speed ?? 1;
    this.paused = message.paused ?? false;
    if (message.state) {
      this.simulation = TransitSim.restore(this.villages, message.state.transit);
      this.sequence = message.state.transit.gameTimeMs / GAME_MS_PER_SIM_TICK;
    } else {
      this.simulation = new TransitSim(this.villages, message.network);
      this.sequence = 0;
    }
    this.simulation.refresh();
    this.bumpNetworkVersion();
    return [this.transitSnapshot(), this.unsolicitedLineFlows()];
  }

  private loadTransitState(requestId: string, state: TransitWorkerSaveState): WorkerRuntimeOutput[] {
    if (!this.simulation) {
      return [{
        type: 'error',
        requestId,
        message: 'Load village data before loading simulation state.',
      }];
    }
    this.simulation = TransitSim.restore(this.villages, state.transit);
    this.seed = state.seed;
    this.sequence = state.transit.gameTimeMs / GAME_MS_PER_SIM_TICK;
    this.simulation.refresh();
    this.bumpNetworkVersion();
    return [
      { type: 'loadStateResult', requestId, ok: true },
      this.transitSnapshot(),
      this.unsolicitedLineFlows(),
    ];
  }

  private bumpNetworkVersion(): void {
    this.networkVersion += 1;
    this.lastSentLineFlows = undefined;
  }

  private requestedLineFlows(requestId: string, lineId?: string): LineFlowsMessage {
    return this.buildLineFlowsMessage(requestId, lineId);
  }

  private unsolicitedLineFlows(): LineFlowsMessage {
    const message = this.buildLineFlowsMessage();
    this.lastSentLineFlows = {
      gameDay: message.gameDay,
      periodId: message.periodId,
      networkVersion: message.networkVersion,
    };
    return message;
  }

  private buildLineFlowsMessage(requestId?: string, lineId?: string): LineFlowsMessage {
    const current = this.simulation?.snapshot();
    return {
      type: 'lineFlows',
      ...(requestId === undefined ? {} : { requestId }),
      gameDay: current?.gameDay ?? 0,
      periodId: current?.currentPeriodId ?? 'morningPeak',
      networkVersion: this.networkVersion,
      lines: this.simulation?.lineFlows(lineId) ?? [],
    };
  }

  private transitSnapshot(): Extract<TransitWorkerToMainMessage, { type: 'snapshot' }> {
    const summary = this.simulation!.snapshot();
    const snapshot: TransitWorkerSnapshot = {
      ...summary,
      seq: this.sequence,
      seed: this.seed,
      trains: visibleTrainPositions(this.simulation!.network, summary.currentPeriodId, summary.gameTimeMs),
      // The worker shell replaces this placeholder with its measured wall time.
      recomputeMs: 0,
    };
    return { type: 'snapshot', snapshot };
  }
}

export function visibleTrainPositions(
  network: Network,
  periodId: TransitWorkerSnapshot['currentPeriodId'],
  gameTimeMs: number,
): TrainPosition[] {
  const stationsById = new Map<string, Station>(network.stations.map((station) => [station.id, station]));
  const lines = [...network.lines].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const trains: TrainPosition[] = [];
  for (const line of lines) {
    const remaining = MAX_VISIBLE_TRAINS - trains.length;
    if (remaining <= 0) break;
    const periodTrainCount = trainsForPeriod(line, periodId);
    const trainCount = Math.min(periodTrainCount, remaining);
    if (trainCount <= 0) continue;
    const route = routeForLine(line, stationsById);
    if (route.lengthKm <= 0 || route.stations.length < 2) continue;
    const roundTripSeconds = lineRoundTripTimeSeconds(line, network.stations);
    if (!Number.isFinite(roundTripSeconds) || roundTripSeconds <= 0) continue;
    const headwaySeconds = roundTripSeconds / periodTrainCount;
    for (let index = 0; index < trainCount; index += 1) {
      const offsetSeconds = gameTimeMs / 1_000 + index * headwaySeconds;
      const phase = ((offsetSeconds % roundTripSeconds) + roundTripSeconds) % roundTripSeconds;
      const oneWaySeconds = roundTripSeconds / 2;
      const progress = phase <= oneWaySeconds ? phase / oneWaySeconds : 2 - phase / oneWaySeconds;
      const position = pointAlongRoute(route.stations, route.segmentLengthsKm, route.lengthKm * progress);
      if (position) trains.push({ id: `${line.id}-train-${index + 1}`, lineId: line.id, ...position });
    }
  }
  return trains;
}

interface LineRoute {
  stations: Station[];
  segmentLengthsKm: number[];
  lengthKm: number;
}

function routeForLine(line: Line, stationsById: ReadonlyMap<string, Station>): LineRoute {
  const stations = line.stationIds.map((id) => stationsById.get(id)).filter((station): station is Station => station !== undefined);
  const segmentLengthsKm: number[] = [];
  let lengthKm = 0;
  for (let index = 1; index < stations.length; index += 1) {
    const previous = stations[index - 1]!;
    const current = stations[index]!;
    const segmentLength = haversineKm(previous.lon, previous.lat, current.lon, current.lat);
    segmentLengthsKm.push(segmentLength);
    lengthKm += segmentLength;
  }
  return { stations, segmentLengthsKm, lengthKm };
}

function pointAlongRoute(
  stations: readonly Station[],
  lengths: readonly number[],
  distanceKm: number,
): Pick<TrainPosition, 'lon' | 'lat'> | undefined {
  let remaining = Math.max(0, distanceKm);
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index]!;
    const start = stations[index]!;
    const end = stations[index + 1]!;
    if (remaining <= length || index === lengths.length - 1) {
      const fraction = length === 0 ? 0 : Math.min(1, remaining / length);
      return { lon: start.lon + (end.lon - start.lon) * fraction, lat: start.lat + (end.lat - start.lat) * fraction };
    }
    remaining -= length;
  }
  return undefined;
}

export async function loadVillageSource(source: VillageSource): Promise<VillageDemandPoint[]> {
  if (source.kind === 'data') return decodeVillageAttributes(source.villages);
  const response = await fetch(source.url);
  if (!response.ok) throw new Error(`Village demand data request failed (${response.status}).`);
  return decodeVillageAttributes(await response.json() as unknown);
}

function decodeVillageAttributes(value: unknown): VillageDemandPoint[] {
  if (!Array.isArray(value)) throw new Error('Village demand data must be an array.');
  const villages = value.map((item: unknown): VillageDemandPoint => {
    if (!isVillageAttribute(item)) throw new Error('Village demand data contains an invalid row.');
    return {
      code: item.VILLCODE,
      population: item.population,
      lon: item.demandPoint[0],
      lat: item.demandPoint[1],
    };
  }).sort((a, b) => a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
  for (let index = 1; index < villages.length; index += 1) {
    if (villages[index - 1]!.code === villages[index]!.code) {
      throw new Error(`Village demand data contains duplicate VILLCODE ${villages[index]!.code}.`);
    }
  }
  return villages;
}

function isVillageAttribute(value: unknown): value is VillageAttribute {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  if (!('VILLCODE' in value) || !('population' in value) || !('demandPoint' in value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.VILLCODE === 'string' && row.VILLCODE.length > 0
    && isNonNegativeInteger(row.population)
    && Array.isArray(row.demandPoint) && row.demandPoint.length === 2
    && typeof row.demandPoint[0] === 'number' && Number.isFinite(row.demandPoint[0])
    && row.demandPoint[0] >= -180 && row.demandPoint[0] <= 180
    && typeof row.demandPoint[1] === 'number' && Number.isFinite(row.demandPoint[1])
    && row.demandPoint[1] >= -90 && row.demandPoint[1] <= 90;
}

export function gameDayForTime(gameTimeMs: number): number {
  return Math.floor(gameTimeMs / GAME_DAY_MS);
}
