import type { Network } from '../city/network';
import { isNonNegativeInteger, isTrainCount, isValidTransitCars, MAX_NAME_LENGTH } from '../city/limits';
import { SIM_SPEEDS, type SimSpeed } from './clock';
import type { SimContinuationState, SimSnapshot } from './core';
import type { TransitSimSerializedState, TransitSummarySnapshot } from './transit';
import type { LineFlowsData } from './transit/TransitSim';
import type { QualityScore } from './transit/quality';
import type { RepresentativePassenger } from './transit/representative';

export const MAX_NETWORK_LINES = 1_000;
export const MAX_ID_LENGTH = 200;

export interface LegacyStartMessage {
  type: 'start';
  seed: number;
  state?: SimContinuationState;
  paused?: boolean;
  speed?: SimSpeed;
}

export type MainToWorkerMessage = LegacyStartMessage
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'setSpeed'; speed: SimSpeed };

export interface WorkerToMainMessage {
  type: 'snapshot';
  snapshot: SimSnapshot;
}

/** A compact village input that is safe to send to the transit worker. */
export interface VillageAttribute {
  VILLCODE: string;
  population: number;
  demandPoint: [number, number];
}

/** A URL keeps the 1,512-row source payload off the main-thread message queue. */
export type VillageSource =
  | { kind: 'data'; villages: VillageAttribute[] }
  | { kind: 'url'; url: string }
  | { kind: 'urls'; urls: string[] };

/** Version 2 is the continuation envelope stored with the overall save schema v2. */
export interface TransitWorkerSaveState {
  version: 2;
  seed: number;
  transit: TransitSimSerializedState;
}

export interface TrainPosition {
  id: string;
  lineId: string;
  lon: number;
  lat: number;
}

export type TransitLineSummary = Omit<TransitSummarySnapshot['lines'][number], 'sectionFlow' | 'stationFlows'>;

export interface TransitWireSummary extends Omit<TransitSummarySnapshot, 'lines'> {
  lines: TransitLineSummary[];
}

/** Transit summary plus the worker sequence, train positions, and recompute timing. */
export interface TransitWorkerSnapshot extends TransitWireSummary {
  seq: number;
  seed: number;
  trains: TrainPosition[];
  /** Wall-clock milliseconds spent in the worker wrapper's last recompute. */
  recomputeMs: number;
}

export interface TransitStartMessage {
  type: 'start';
  seed: number;
  villages: VillageSource;
  network: Network;
  state?: TransitWorkerSaveState;
  paused?: boolean;
  speed?: SimSpeed;
}

export interface TransitSetNetworkMessage {
  type: 'setNetwork';
  network: Network;
}

export interface TransitPauseMessage {
  type: 'pause';
}

export interface TransitResumeMessage {
  type: 'resume';
}

export interface TransitSetSpeedMessage {
  type: 'setSpeed';
  speed: SimSpeed;
}

export interface TransitLoadStateMessage {
  type: 'loadState';
  requestId: string;
  state: TransitWorkerSaveState;
}

export interface TransitSaveStateMessage {
  type: 'saveState';
  requestId: string;
}

export interface TransitRequestRepresentativePassengerMessage {
  type: 'requestRepresentativePassenger';
  requestId: string;
  stationId: string;
}

export interface TransitRequestLineFlowsMessage {
  type: 'requestLineFlows';
  requestId: string;
  lineId?: string;
}

export type TransitMainToWorkerMessage = TransitStartMessage
  | TransitSetNetworkMessage
  | TransitPauseMessage
  | TransitResumeMessage
  | TransitSetSpeedMessage
  | TransitLoadStateMessage
  | TransitSaveStateMessage
  | TransitRequestRepresentativePassengerMessage
  | TransitRequestLineFlowsMessage;

export interface TransitSnapshotMessage {
  type: 'snapshot';
  snapshot: TransitWorkerSnapshot;
}

export interface TransitSaveStateResultMessage {
  type: 'saveStateResult';
  requestId: string;
  state: TransitWorkerSaveState;
}

export interface TransitLoadStateResultMessage {
  type: 'loadStateResult';
  requestId: string;
  ok: true;
}

export interface TransitRepresentativePassengerResultMessage {
  type: 'representativePassengerResult';
  requestId: string;
  passenger: RepresentativePassenger | null;
}

export interface LineFlowsMessage {
  type: 'lineFlows';
  requestId?: string;
  gameDay: number;
  periodId: TransitSummarySnapshot['currentPeriodId'];
  networkVersion: number;
  lines: LineFlowsData[];
}

export interface TransitErrorMessage {
  type: 'error';
  message: string;
  requestId?: string;
}

export type TransitWorkerToMainMessage = TransitSnapshotMessage
  | TransitSaveStateResultMessage
  | TransitLoadStateResultMessage
  | TransitRepresentativePassengerResultMessage
  | LineFlowsMessage
  | TransitErrorMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isSeed(value: unknown): value is number {
  return isNonNegativeInteger(value) && value <= 0xffff_ffff;
}

function isSimSpeed(value: unknown): value is SimSpeed {
  return SIM_SPEEDS.some((speed) => speed === value);
}

function isPair(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2
    && isFiniteNumber(value[0]) && isFiniteNumber(value[1]);
}

function isLegacyContinuationState(value: unknown): value is SimContinuationState {
  if (!isRecord(value)) return false;
  return isSeed(value.seed)
    && isSeed(value.rngState)
    && isNonNegativeInteger(value.seq)
    && isNonNegativeNumber(value.gameTimeMs)
    && isFiniteNumber(value.routeProgress)
    && value.routeProgress >= 0
    && value.routeProgress < 1;
}

function isVillageSource(value: unknown): value is VillageSource {
  if (!isRecord(value)) return false;
  if (value.kind === 'url') {
    return typeof value.url === 'string' && value.url.length > 0 && value.url.length <= 2_000;
  }
  if (value.kind === 'urls') {
    return Array.isArray(value.urls) && value.urls.length >= 1 && value.urls.length <= 8
      && value.urls.every((url: unknown) => typeof url === 'string' && url.length > 0 && url.length <= 2_000);
  }
  if (value.kind !== 'data' || !Array.isArray(value.villages) || value.villages.length > 20_000) return false;
  const codes = new Set<string>();
  for (const village of value.villages) {
    if (!isRecord(village) || typeof village.VILLCODE !== 'string' || village.VILLCODE.length === 0
      || codes.has(village.VILLCODE) || !isNonNegativeInteger(village.population)
      || !isPair(village.demandPoint) || village.demandPoint[0] < -180 || village.demandPoint[0] > 180
      || village.demandPoint[1] < -90 || village.demandPoint[1] > 90) return false;
    codes.add(village.VILLCODE);
  }
  return true;
}

function isNetwork(value: unknown): value is Network {
  if (!isRecord(value) || !Array.isArray(value.stations) || value.stations.length > 10_000
    || !Array.isArray(value.lines) || value.lines.length > MAX_NETWORK_LINES
    || !isNonNegativeInteger(value.nextId) || value.nextId < 1) return false;

  const stationIds = new Set<string>();
  for (const station of value.stations) {
    if (!isRecord(station) || typeof station.id !== 'string' || station.id.length === 0
      || station.id.length > MAX_ID_LENGTH
      || stationIds.has(station.id) || typeof station.name !== 'string' || station.name.length > MAX_NAME_LENGTH
      || !isFiniteNumber(station.lon) || station.lon < -180 || station.lon > 180
      || !isFiniteNumber(station.lat) || station.lat < -90 || station.lat > 90
      || (station.nameManual !== undefined && typeof station.nameManual !== 'boolean')) return false;
    stationIds.add(station.id);
  }

  const lineIds = new Set<string>();
  for (const line of value.lines) {
    if (!isRecord(line) || typeof line.id !== 'string' || line.id.length === 0
      || line.id.length > MAX_ID_LENGTH || lineIds.has(line.id)
      || (line.mode !== 'brt' && line.mode !== 'metro') || !Array.isArray(line.stationIds)
      || line.stationIds.length < 2 || !line.stationIds.every((id: unknown) => typeof id === 'string' && stationIds.has(id))
      || new Set(line.stationIds).size !== line.stationIds.length
      || !isTrainCount(line.peakTrains) || !isTrainCount(line.offPeakTrains)
      || !isValidTransitCars(line.mode, line.cars) || typeof line.name !== 'string'
      || line.name.length > MAX_NAME_LENGTH
      || typeof line.color !== 'string') return false;
    lineIds.add(line.id);
  }
  return true;
}

const PERIOD_IDS = ['morningPeak', 'offPeak', 'eveningPeak', 'night'] as const;

function isPeriodId(value: unknown): boolean {
  return PERIOD_IDS.some((periodId) => periodId === value);
}

function areFiniteNumbers(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(isFiniteNumber);
}

function isQualityRawStats(value: unknown): boolean {
  return isRecord(value)
    && isNonNegativeNumber(value.averageWaitMinutes)
    && isNonNegativeNumber(value.averageTransfers)
    && isNonNegativeNumber(value.averageLoadFactor)
    && isFiniteNumber(value.deniedRatio) && value.deniedRatio >= 0 && value.deniedRatio <= 1;
}

function isQualityScore(value: unknown, allowMissingMetrics = false): value is QualityScore {
  if (!isRecord(value)) return false;
  const validScores = ['wait', 'transfer', 'crowding', 'denied', 'total'].every((key) => {
    const score = value[key];
    return isFiniteNumber(score) && score >= 0 && score <= 100;
  });
  return validScores && (isQualityRawStats(value.metrics)
    || (allowMissingMetrics && value.metrics === undefined));
}

function isQualityOrMissingLegacy(value: unknown, allowMissing: boolean): boolean {
  return (allowMissing && value === undefined) || value === null || isQualityScore(value, allowMissing);
}

function isSegmentFlow(value: unknown): boolean {
  return isRecord(value)
    && isNonNegativeNumber(value.load)
    && isNonNegativeNumber(value.capacity)
    && isNonNegativeNumber(value.loadFactor);
}

function isDirectionalSectionFlow(value: unknown, segmentCount: number): boolean {
  return Array.isArray(value) && value.length === segmentCount && value.every(isSegmentFlow);
}

function isSectionFlow(value: unknown, stationCount: number): boolean {
  if (!isRecord(value)) return false;
  const segmentCount = stationCount - 1;
  return PERIOD_IDS.every((periodId) => {
    const period = value[periodId];
    return isRecord(period)
      && isDirectionalSectionFlow(period.forward, segmentCount)
      && isDirectionalSectionFlow(period.backward, segmentCount);
  });
}

function isDirectionalStationFlow(value: unknown, stationCount: number): boolean {
  return isRecord(value)
    && Array.isArray(value.boardings) && value.boardings.length === stationCount
    && value.boardings.every(isNonNegativeNumber)
    && Array.isArray(value.alightings) && value.alightings.length === stationCount
    && value.alightings.every(isNonNegativeNumber);
}

function isStationFlows(value: unknown, stationCount: number): boolean {
  if (!isRecord(value)) return false;
  return PERIOD_IDS.every((periodId) => {
    const period = value[periodId];
    return isRecord(period)
      && isDirectionalStationFlow(period.forward, stationCount)
      && isDirectionalStationFlow(period.backward, stationCount);
  });
}

function isTransitSummary(
  value: unknown,
  allowMissingQuality: boolean,
  allowMissingSectionFlow: boolean,
  forbidSectionFlow: true,
): value is TransitWireSummary;
function isTransitSummary(
  value: unknown,
  allowMissingQuality?: boolean,
  allowMissingSectionFlow?: boolean,
): value is TransitSummarySnapshot;
function isTransitSummary(
  value: unknown,
  allowMissingQuality = false,
  allowMissingSectionFlow = false,
  forbidSectionFlow = false,
): value is TransitSummarySnapshot | TransitWireSummary {
  if (!isRecord(value) || !isNonNegativeNumber(value.gameTimeMs)
    || !isNonNegativeInteger(value.gameDay) || !isPeriodId(value.currentPeriodId)
    || !isNonNegativeInteger(value.pathRecomputeCount) || !isNonNegativeInteger(value.demandPairCount)
    || !isRecord(value.city) || !Array.isArray(value.stations) || !Array.isArray(value.lines)) return false;

  const city = value.city;
  if (!isNonNegativeInteger(city.gameDay)
    || !isNonNegativeNumber(city.dailyRidership) || !isNonNegativeNumber(city.potentialTrips)
    || !isFiniteNumber(city.transitShare) || city.transitShare < 0 || city.transitShare > 1
    || !isNonNegativeNumber(city.deniedBoardings) || !isNonNegativeNumber(city.transfers)
    || !isQualityOrMissingLegacy(city.quality, allowMissingQuality)
    || !isNonNegativeNumber(city.fareRevenue) || !isNonNegativeNumber(city.operatingCost)
    || !isFiniteNumber(city.profitLossRatio)) return false;

  for (const station of value.stations) {
    if (!isRecord(station) || typeof station.stationId !== 'string' || station.stationId.length === 0
      || typeof station.name !== 'string'
      || !isNonNegativeNumber(station.entries) || !isNonNegativeNumber(station.exits)
      || !isNonNegativeNumber(station.entriesExits) || !isNonNegativeNumber(station.peakPlatformWaiting)
      || !isNonNegativeNumber(station.deniedBoardings) || !isNonNegativeNumber(station.transfers)
      || !Array.isArray(station.lineIds) || !station.lineIds.every((lineId: unknown) => typeof lineId === 'string')
      || !areFiniteNumbers(station.last7DaysEntriesExits) || station.last7DaysEntriesExits.length > 7
      || station.last7DaysEntriesExits.some((count) => count < 0)) return false;
  }

  for (const line of value.lines) {
    if (!isRecord(line) || typeof line.lineId !== 'string' || line.lineId.length === 0
      || typeof line.name !== 'string' || (line.mode !== 'brt' && line.mode !== 'metro')
      || !isNonNegativeInteger(line.stationCount) || line.stationCount < 2 || !isNonNegativeNumber(line.lengthKm)
      || !isNonNegativeInteger(line.cars) || !isNonNegativeInteger(line.peakTrains)
      || !isNonNegativeInteger(line.offPeakTrains)
      || !isQualityOrMissingLegacy(line.quality, allowMissingQuality)
      || !(forbidSectionFlow
        ? line.sectionFlow === undefined && line.stationFlows === undefined
        : (allowMissingSectionFlow && line.sectionFlow === undefined && line.stationFlows === undefined)
          || (isSectionFlow(line.sectionFlow, line.stationCount)
            && isStationFlows(line.stationFlows, line.stationCount)))
      || !Array.isArray(line.periods) || line.periods.length !== 4
      || !line.periods.every((period: unknown) => isRecord(period)
        && isPeriodId(period.periodId) && typeof period.periodName === 'string'
        && isNonNegativeNumber(period.maxLoadFactor) && isNonNegativeNumber(period.operatingCost)
        && isNonNegativeNumber(period.roundTripTimeSeconds)
        && (period.headwaySeconds === null || isNonNegativeNumber(period.headwaySeconds))
        && isNonNegativeNumber(period.hourlyCapacity) && isNonNegativeNumber(period.periodCapacity))
      || !Array.isArray(line.spacingWarnings) || !line.spacingWarnings.every((warning: unknown) => {
        if (!isRecord(warning) || warning.lineId !== line.lineId
          || !isNonNegativeInteger(warning.segmentIndex) || !isNonNegativeNumber(warning.spacingKm)
          || !isPair(warning.recommendedKm)) return false;
        return warning.recommendedKm[0] >= 0 && warning.recommendedKm[1] >= warning.recommendedKm[0];
      })) return false;
  }
  return true;
}

function isSerializedTransitState(value: unknown): value is TransitSimSerializedState {
  if (!isRecord(value) || value.version !== 1 || typeof value.villageFingerprint !== 'string'
    || !isNetwork(value.network) || !isNonNegativeNumber(value.gameTimeMs)
    || !isNonNegativeInteger(value.pathRecomputeCount) || !Array.isArray(value.actualAttempts)
    || !isTransitSummary(value.snapshot, true, true)) return false;
  const attemptKeys = new Set<string>();
  for (const attempt of value.actualAttempts) {
    if (!isRecord(attempt) || typeof attempt.key !== 'string' || attemptKeys.has(attempt.key)
      || !isNonNegativeNumber(attempt.trips)) return false;
    attemptKeys.add(attempt.key);
  }
  return true;
}

export function isTransitWorkerSaveState(value: unknown): value is TransitWorkerSaveState {
  return isRecord(value) && value.version === 2 && isSeed(value.seed)
    && isSerializedTransitState(value.transit)
    && value.transit.gameTimeMs % 60_000 === 0;
}

export function isTransitWorkerSnapshot(value: unknown): value is TransitWorkerSnapshot {
  if (!isRecord(value) || !isNonNegativeInteger(value.seq) || !isSeed(value.seed)
    || !Array.isArray(value.trains) || value.trains.length > 300
    || !isNonNegativeNumber(value.recomputeMs)) return false;
  const trains = value.trains;
  if (!isTransitSummary(value, false, false, true)) return false;
  return trains.every((train: unknown) => isRecord(train)
    && typeof train.id === 'string' && train.id.length > 0
    && typeof train.lineId === 'string' && train.lineId.length > 0
    && isFiniteNumber(train.lon) && train.lon >= -180 && train.lon <= 180
    && isFiniteNumber(train.lat) && train.lat >= -90 && train.lat <= 90);
}

function isPassengerLeg(value: unknown): boolean {
  if (!isRecord(value) || !['walkIn', 'wait', 'ride', 'transfer', 'walkOut'].some((kind) => kind === value.kind)
    || !isNonNegativeNumber(value.minutes)) return false;
  const validStationFields = ['lineId', 'fromStationId', 'toStationId'].every((key) => {
    const field = value[key];
    return field === undefined || (typeof field === 'string' && field.length > 0 && field.length <= 200);
  });
  if (!validStationFields) return false;
  const viaStationIds = value.viaStationIds;
  return viaStationIds === undefined || (value.kind === 'ride'
    && Array.isArray(viaStationIds)
    && viaStationIds.length >= 2 && viaStationIds.length <= 200
    && viaStationIds.every((stationId: unknown) => typeof stationId === 'string'
      && stationId.length > 0 && stationId.length <= MAX_ID_LENGTH));
}

function isRepresentativePassenger(value: unknown): value is RepresentativePassenger {
  return isRecord(value)
    && typeof value.selectedStationId === 'string' && value.selectedStationId.length > 0 && value.selectedStationId.length <= 200
    && typeof value.odKey === 'string' && value.odKey.length > 0 && value.odKey.length <= 500
    && isNonNegativeNumber(value.flow)
    && typeof value.startStationId === 'string' && value.startStationId.length > 0 && value.startStationId.length <= 200
    && typeof value.endStationId === 'string' && value.endStationId.length > 0 && value.endStationId.length <= 200
    && typeof value.pathSignature === 'string' && value.pathSignature.length > 0 && value.pathSignature.length <= 200_000
    && Array.isArray(value.legs) && value.legs.length > 0 && value.legs.length <= 5_000
    && value.legs.every(isPassengerLeg)
    && isNonNegativeNumber(value.doorToDoorMinutes)
    && (value.alternativeMinutes === null || isNonNegativeNumber(value.alternativeMinutes));
}

function isLegacySnapshot(value: unknown): value is SimSnapshot {
  if (!isRecord(value) || !isNonNegativeInteger(value.seq) || !isNonNegativeNumber(value.gameTimeMs)
    || !isSeed(value.seed) || !isSeed(value.rngState)
    || !isFiniteNumber(value.routeProgress) || value.routeProgress < 0 || value.routeProgress >= 1
    || !Array.isArray(value.entities)) return false;
  return value.entities.every((entity: unknown) => isRecord(entity)
    && typeof entity.id === 'string' && isFiniteNumber(entity.lon) && isFiniteNumber(entity.lat));
}

export function isTransitStartMessage(value: unknown): value is TransitStartMessage {
  return isRecord(value) && value.type === 'start' && isSeed(value.seed)
    && isVillageSource(value.villages) && isNetwork(value.network)
    && (value.state === undefined || (isTransitWorkerSaveState(value.state) && value.state.seed === value.seed))
    && (value.paused === undefined || typeof value.paused === 'boolean')
    && (value.speed === undefined || isSimSpeed(value.speed));
}

export function isTransitSetNetworkMessage(value: unknown): value is TransitSetNetworkMessage {
  return isRecord(value) && value.type === 'setNetwork' && isNetwork(value.network);
}

export function isTransitPauseMessage(value: unknown): value is TransitPauseMessage {
  return isRecord(value) && value.type === 'pause';
}

export function isTransitResumeMessage(value: unknown): value is TransitResumeMessage {
  return isRecord(value) && value.type === 'resume';
}

export function isTransitSetSpeedMessage(value: unknown): value is TransitSetSpeedMessage {
  return isRecord(value) && value.type === 'setSpeed' && isSimSpeed(value.speed);
}

export function isTransitLoadStateMessage(value: unknown): value is TransitLoadStateMessage {
  return isRecord(value) && value.type === 'loadState' && isRequestId(value.requestId)
    && isTransitWorkerSaveState(value.state);
}

export function isTransitSaveStateMessage(value: unknown): value is TransitSaveStateMessage {
  return isRecord(value) && value.type === 'saveState' && isRequestId(value.requestId);
}

export function isTransitRequestRepresentativePassengerMessage(
  value: unknown,
): value is TransitRequestRepresentativePassengerMessage {
  return isRecord(value) && value.type === 'requestRepresentativePassenger'
    && isRequestId(value.requestId)
    && typeof value.stationId === 'string' && value.stationId.length > 0 && value.stationId.length <= MAX_ID_LENGTH;
}

export function isTransitRequestLineFlowsMessage(value: unknown): value is TransitRequestLineFlowsMessage {
  return isRecord(value) && value.type === 'requestLineFlows'
    && isRequestId(value.requestId)
    && (value.lineId === undefined
      || (typeof value.lineId === 'string' && value.lineId.length > 0 && value.lineId.length <= MAX_ID_LENGTH));
}

export function isTransitMainToWorkerMessage(value: unknown): value is TransitMainToWorkerMessage {
  return isTransitStartMessage(value) || isTransitSetNetworkMessage(value)
    || isTransitPauseMessage(value) || isTransitResumeMessage(value)
    || isTransitSetSpeedMessage(value) || isTransitLoadStateMessage(value)
    || isTransitSaveStateMessage(value) || isTransitRequestRepresentativePassengerMessage(value)
    || isTransitRequestLineFlowsMessage(value);
}

export function isTransitSnapshotMessage(value: unknown): value is TransitSnapshotMessage {
  return isRecord(value) && value.type === 'snapshot' && isTransitWorkerSnapshot(value.snapshot);
}

export function isTransitSaveStateResultMessage(value: unknown): value is TransitSaveStateResultMessage {
  return isRecord(value) && value.type === 'saveStateResult' && isRequestId(value.requestId)
    && isTransitWorkerSaveState(value.state);
}

export function isTransitLoadStateResultMessage(value: unknown): value is TransitLoadStateResultMessage {
  return isRecord(value) && value.type === 'loadStateResult' && isRequestId(value.requestId) && value.ok === true;
}

export function isTransitRepresentativePassengerResultMessage(
  value: unknown,
): value is TransitRepresentativePassengerResultMessage {
  return isRecord(value) && value.type === 'representativePassengerResult'
    && isRequestId(value.requestId)
    && (value.passenger === null || isRepresentativePassenger(value.passenger));
}

export function isTransitLineFlowsMessage(value: unknown): value is LineFlowsMessage {
  if (!isRecord(value) || value.type !== 'lineFlows'
    || (value.requestId !== undefined && !isRequestId(value.requestId))
    || !isNonNegativeInteger(value.gameDay) || !isPeriodId(value.periodId)
    || !isNonNegativeInteger(value.networkVersion)
    || !Array.isArray(value.lines) || value.lines.length > MAX_NETWORK_LINES) return false;
  return value.lines.every((line: unknown) => isRecord(line)
    && typeof line.lineId === 'string' && line.lineId.length > 0 && line.lineId.length <= MAX_ID_LENGTH
    && isNonNegativeInteger(line.stationCount) && line.stationCount >= 2
    && isSectionFlow(line.sectionFlow, line.stationCount)
    && isStationFlows(line.stationFlows, line.stationCount));
}

export function isTransitErrorMessage(value: unknown): value is TransitErrorMessage {
  return isRecord(value) && value.type === 'error' && typeof value.message === 'string'
    && (value.requestId === undefined || isRequestId(value.requestId));
}

export function isTransitWorkerToMainMessage(value: unknown): value is TransitWorkerToMainMessage {
  return isTransitSnapshotMessage(value) || isTransitSaveStateResultMessage(value)
    || isTransitLoadStateResultMessage(value) || isTransitRepresentativePassengerResultMessage(value)
    || isTransitLineFlowsMessage(value) || isTransitErrorMessage(value);
}

function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200;
}

function isLegacyStartMessage(value: unknown): value is LegacyStartMessage {
  if (!isRecord(value) || value.type !== 'start' || !isSeed(value.seed)
    || (value.paused !== undefined && typeof value.paused !== 'boolean')
    || (value.speed !== undefined && !isSimSpeed(value.speed))) return false;
  if (value.state === undefined) return true;
  return isLegacyContinuationState(value.state) && value.state.seed === value.seed;
}

/** Guard for the P0 worker protocol; transit messages use isTransitMainToWorkerMessage. */
export function isMainToWorkerMessage(value: unknown): value is MainToWorkerMessage {
  if (isLegacyStartMessage(value)) return true;
  if (!isRecord(value)) return false;
  if (value.type === 'pause' || value.type === 'resume') return true;
  return value.type === 'setSpeed' && isSimSpeed(value.speed);
}

/** Guard for the P0 worker replies; transit replies use isTransitWorkerToMainMessage. */
export function isWorkerToMainMessage(value: unknown): value is WorkerToMainMessage {
  return isRecord(value) && value.type === 'snapshot' && isLegacySnapshot(value.snapshot);
}
