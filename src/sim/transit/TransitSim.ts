import {
  createEmptyNetwork,
  lineHourlyCapacity,
  lineSpacingWarnings,
  trainsForPeriod,
  type Line,
  type Network,
  type Station,
} from '../../city/network';
import { compareText } from '../compare';
import {
  GAME_DAY_MS,
  SIMULATION_BALANCE,
  TRANSIT_MODES,
  type SimulationPeriodId,
} from '../../city/modes';
import {
  buildVillageDemandModel,
  type DemandParameters,
  type VillageDemandModel,
  type VillageDemandPoint,
} from './demand';
import {
  buildTransitGraph,
  precomputeVillageAccess,
  shortestStationPath,
  type LineRuntimeMetrics,
  type TransitGraphRuntime,
  type TransitPath,
  type WalkAccess,
} from './graph';
import { calculateQualityScore, summarizePathCrowding, type QualityScore } from './quality';
import {
  addIndexedCountyFlow,
  countyOfVillage,
  summarizeCountyFlows,
  type CountyFlow,
  type CountyFlowTotals,
} from './cross-city';
import {
  buildRepresentativeTripPath,
  compareRepresentativeTripRouteKeys,
  representativeStationIds,
  representativeTripRouteOrder,
  selectRepresentativeTrip,
  type RepresentativePassenger,
  type RepresentativeTripRoute,
} from './representative';

export interface ModeShares {
  transit: number;
  alternative: number;
}

/** Deterministic two-mode logit. A missing transit path assigns all demand to the alternative. */
export function binaryLogitShares(
  transitTimeSeconds: number | null,
  alternativeTimeSeconds: number,
  scaleSeconds = SIMULATION_BALANCE.logitScaleSeconds,
): ModeShares {
  if (!Number.isFinite(alternativeTimeSeconds) || alternativeTimeSeconds < 0
    || !Number.isFinite(scaleSeconds) || scaleSeconds <= 0) {
    throw new RangeError('Mode choice times must be finite and the logit scale must be positive.');
  }
  if (transitTimeSeconds === null || !Number.isFinite(transitTimeSeconds) || transitTimeSeconds < 0) {
    return { transit: 0, alternative: 1 };
  }
  const difference = (transitTimeSeconds - alternativeTimeSeconds) / scaleSeconds;
  const transit = difference >= 0
    ? Math.exp(-difference) / (1 + Math.exp(-difference))
    : 1 / (1 + Math.exp(difference));
  return { transit, alternative: 1 - transit };
}

export interface CityDailyStats {
  gameDay: number;
  dailyRidership: number;
  potentialTrips: number;
  transitShare: number;
  deniedBoardings: number;
  transfers: number;
  quality: QualityScore | null;
  fareRevenue: number;
  countyFlows?: CountyFlow[];
  operatingCost: number;
  /** (revenue − cost) / cost; zero when no service cost exists. */
  profitLossRatio: number;
}

export interface StationDailyStats {
  stationId: string;
  name: string;
  entries: number;
  exits: number;
  entriesExits: number;
  /** Estimated peak waiting riders = peak boardings/hour × half-headway / 3,600. */
  peakPlatformWaiting: number;
  deniedBoardings: number;
  transfers: number;
  lineIds: string[];
  last7DaysEntriesExits: number[];
}

export interface LinePeriodStats {
  periodId: SimulationPeriodId;
  periodName: string;
  maxLoadFactor: number;
  operatingCost: number;
  roundTripTimeSeconds: number;
  headwaySeconds: number | null;
  hourlyCapacity: number;
  periodCapacity: number;
}

export interface SegmentFlow {
  load: number;
  capacity: number;
  loadFactor: number;
}

export interface LineSectionFlowPeriod {
  /** Array indices follow line.stationIds order, regardless of travel direction. */
  forward: SegmentFlow[];
  backward: SegmentFlow[];
}

export interface LineStationFlowPeriod {
  /** Arrays follow line.stationIds order; values count riders boarding/alighting per station. */
  forward: { boardings: number[]; alightings: number[] };
  backward: { boardings: number[]; alightings: number[] };
}

export interface LineDailyStats {
  lineId: string;
  name: string;
  mode: Line['mode'];
  stationCount: number;
  lengthKm: number;
  cars: number;
  peakTrains: number;
  offPeakTrains: number;
  spacingWarnings: ReturnType<typeof lineSpacingWarnings>;
  periods: LinePeriodStats[];
  /** Flow data stays inside the worker and is sent through lineFlows, not in tick snapshots or saves. */
  sectionFlow: Record<SimulationPeriodId, LineSectionFlowPeriod>;
  /** Station totals support checking that directional section loads conserve riders. */
  stationFlows: Record<SimulationPeriodId, LineStationFlowPeriod>;
  quality: QualityScore | null;
}

export interface LineFlowsData {
  lineId: string;
  stationCount: number;
  sectionFlow: LineDailyStats['sectionFlow'];
  stationFlows: LineDailyStats['stationFlows'];
}

export interface TransitSummarySnapshot {
  gameTimeMs: number;
  gameDay: number;
  currentPeriodId: SimulationPeriodId;
  pathRecomputeCount: number;
  demandPairCount: number;
  city: CityDailyStats;
  stations: StationDailyStats[];
  lines: LineDailyStats[];
}

type TransitSnapshotLineState = Omit<LineDailyStats, 'sectionFlow' | 'stationFlows'>
  & Partial<Pick<LineDailyStats, 'sectionFlow' | 'stationFlows'>>;

type TransitSnapshotState = Omit<TransitSummarySnapshot, 'lines'> & {
  lines: TransitSnapshotLineState[];
};

export interface TransitSimSerializedState {
  version: 1;
  villageFingerprint: string;
  network: Network;
  gameTimeMs: number;
  pathRecomputeCount: number;
  actualAttempts: Array<{ key: string; trips: number }>;
  snapshot: TransitSnapshotState;
}

interface EquilibriumRoute {
  path: TransitPath;
  desiredTrips: number;
  fareTotal: number;
  countyFlows: Map<number, CountyFlowTotals>;
}

interface VillageToStationPath {
  path: TransitPath;
  timeSeconds: number;
  walkSeconds: number;
}

type VillagePathTable = Array<Array<VillageToStationPath | null | undefined>>;

interface PeriodEquilibrium {
  periodId: SimulationPeriodId;
  potentialTrips: number;
  routes: EquilibriumRoute[];
}

interface StationAccumulator {
  entries: number;
  exits: number;
  denied: number;
  transfers: number;
  waitByPeriod: Map<SimulationPeriodId, number>;
}

interface PeriodLoadData {
  periodId: SimulationPeriodId;
  periodCapacityBySegment: Map<string, number>;
  attemptedLoadBySegment: Map<string, number>;
  operatingCostByLine: Map<string, number>;
  hourlyCapacityByLine: Map<string, number>;
}

interface QualityAccumulator {
  passengers: number;
  waitMinutes: number;
  transfers: number;
  weightedLoadFactor: number;
  loadFactorPassengers: number;
  attempted: number;
  denied: number;
}

interface LineStationFlowAccumulator {
  forward: { boardings: number[]; alightings: number[] };
  backward: { boardings: number[]; alightings: number[] };
}

function emptyQualityAccumulator(): QualityAccumulator {
  return {
    passengers: 0,
    waitMinutes: 0,
    transfers: 0,
    weightedLoadFactor: 0,
    loadFactorPassengers: 0,
    attempted: 0,
    denied: 0,
  };
}

function qualityFromAccumulator(accumulator: QualityAccumulator): QualityScore | null {
  return calculateQualityScore({
    passengerCount: accumulator.passengers,
    averageWaitMinutes: accumulator.passengers > 0
      ? accumulator.waitMinutes / accumulator.passengers
      : 0,
    averageTransfers: accumulator.passengers > 0
      ? accumulator.transfers / accumulator.passengers
      : 0,
    averageLoadFactor: accumulator.loadFactorPassengers > 0
      ? accumulator.weightedLoadFactor / accumulator.loadFactorPassengers
      : 0,
    deniedRatio: accumulator.attempted > 0 ? accumulator.denied / accumulator.attempted : 0,
  });
}

function segmentKey(lineId: string, segmentIndex: number, direction: 1 | -1): string {
  return `${lineId}\u0000${segmentIndex}\u0000${direction}`;
}

function routeStateKey(periodId: SimulationPeriodId, routeSignature: string): string {
  return `${periodId}\u0000${routeSignature}`;
}

function transitPathSignature(legs: TransitPath['legs']): string {
  return legs
    .map((leg) => `${leg.lineId}:${leg.fromStationId}>${leg.toStationId}:${leg.segments.map(({ segmentIndex, direction }) => `${segmentIndex}${direction > 0 ? '+' : '-'}`).join(',')}`)
    .join('|');
}

/** Reverses a shortest path. Ride and transfer costs are symmetric by construction. */
function reverseTransitPath(path: TransitPath): TransitPath {
  const legs = [...path.legs].reverse().map((leg) => ({
    lineId: leg.lineId,
    fromStationId: leg.toStationId,
    toStationId: leg.fromStationId,
    segments: [...leg.segments].reverse().map((segment) => ({
      ...segment,
      direction: segment.direction === 1 ? -1 as const : 1 as const,
    })),
  }));
  return {
    startStationId: path.endStationId,
    endStationId: path.startStationId,
    timeSeconds: path.timeSeconds,
    legs,
    transfers: path.transfers,
    signature: transitPathSignature(legs),
  };
}

function copyNetwork(network: Network): Network {
  return {
    stations: network.stations.map((station) => ({ ...station })),
    lines: network.lines.map((line) => ({ ...line, stationIds: [...line.stationIds] })),
    nextId: network.nextId,
  };
}

function fingerprintVillages(villages: readonly VillageDemandPoint[]): string {
  let hash = 0x811c9dc5;
  const text = villages
    .map((village) => `${village.code}:${village.population}:${village.lon}:${village.lat}`)
    .join('\n');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${villages.length}-${hash.toString(16).padStart(8, '0')}`;
}

function periodAt(gameTimeMs: number): SimulationPeriodId {
  let remainingHours = (gameTimeMs % GAME_DAY_MS) / 3_600_000;
  for (const period of SIMULATION_BALANCE.periods) {
    if (remainingHours < period.durationHours) return period.id;
    remainingHours -= period.durationHours;
  }
  return SIMULATION_BALANCE.periods[0]!.id;
}

function fareForDistance(distanceKm: number): number {
  return Math.min(
    SIMULATION_BALANCE.fare.maximum,
    SIMULATION_BALANCE.fare.base + distanceKm * SIMULATION_BALANCE.fare.perKm,
  );
}

const SERVICE_PERIOD_GROUPS: ReadonlyArray<{
  representative: SimulationPeriodId;
  periods: readonly SimulationPeriodId[];
}> = [
  { representative: 'morningPeak', periods: ['morningPeak', 'eveningPeak'] },
  { representative: 'offPeak', periods: ['offPeak', 'night'] },
];

function cloneSnapshot(snapshot: TransitSnapshotState): TransitSummarySnapshot {
  return {
    ...snapshot,
    city: {
      ...snapshot.city,
      quality: snapshot.city.quality ? {
        ...snapshot.city.quality,
        metrics: snapshot.city.quality.metrics ? { ...snapshot.city.quality.metrics } : undefined,
      } : null,
      ...(snapshot.city.countyFlows === undefined ? {} : {
        countyFlows: snapshot.city.countyFlows.map((flow) => ({ ...flow })),
      }),
    },
    stations: snapshot.stations.map((station) => ({
      ...station,
      lineIds: [...station.lineIds],
      last7DaysEntriesExits: [...station.last7DaysEntriesExits],
    })),
    lines: snapshot.lines.map((line) => ({
      ...line,
      quality: line.quality ? {
        ...line.quality,
        metrics: line.quality.metrics ? { ...line.quality.metrics } : undefined,
      } : null,
      spacingWarnings: line.spacingWarnings.map((warning) => ({
        ...warning,
        recommendedKm: [...warning.recommendedKm] as [number, number],
      })),
      periods: line.periods.map((period) => ({ ...period })),
      sectionFlow: cloneSectionFlow(line),
      stationFlows: cloneStationFlows(line),
    })),
  };
}

function cloneSectionFlow(line: TransitSnapshotLineState): Record<SimulationPeriodId, LineSectionFlowPeriod> {
  const fallbackFor = (periodId: SimulationPeriodId): LineSectionFlowPeriod => {
    const capacity = line.periods.find((period) => period.periodId === periodId)?.periodCapacity ?? 0;
    const emptySegment = (): SegmentFlow => ({ load: 0, capacity, loadFactor: 0 });
    return {
      forward: Array.from({ length: Math.max(0, line.stationCount - 1) }, emptySegment),
      backward: Array.from({ length: Math.max(0, line.stationCount - 1) }, emptySegment),
    };
  };
  const source = line.sectionFlow as Partial<Record<SimulationPeriodId, LineSectionFlowPeriod>> | undefined;
  return Object.fromEntries(SIMULATION_BALANCE.periods.map(({ id }) => {
    const period = source?.[id] ?? fallbackFor(id);
    return [id, {
      forward: period.forward.map((segment) => ({ ...segment })),
      backward: period.backward.map((segment) => ({ ...segment })),
    }];
  })) as Record<SimulationPeriodId, LineSectionFlowPeriod>;
}

function cloneStationFlows(line: TransitSnapshotLineState): Record<SimulationPeriodId, LineStationFlowPeriod> {
  const emptyDirection = () => ({
    boardings: Array<number>(Math.max(0, line.stationCount)).fill(0),
    alightings: Array<number>(Math.max(0, line.stationCount)).fill(0),
  });
  const source = line.stationFlows as Partial<Record<SimulationPeriodId, LineStationFlowPeriod>> | undefined;
  return Object.fromEntries(SIMULATION_BALANCE.periods.map(({ id }) => {
    const period = source?.[id] ?? { forward: emptyDirection(), backward: emptyDirection() };
    return [id, {
      forward: {
        boardings: [...period.forward.boardings],
        alightings: [...period.forward.alightings],
      },
      backward: {
        boardings: [...period.backward.boardings],
        alightings: [...period.backward.alightings],
      },
    }];
  })) as Record<SimulationPeriodId, LineStationFlowPeriod>;
}

function snapshotWithoutFlows(snapshot: TransitSummarySnapshot): TransitSnapshotState {
  return {
    ...snapshot,
    lines: snapshot.lines.map((line) => {
      const savedLine: TransitSnapshotLineState = { ...line };
      delete savedLine.sectionFlow;
      delete savedLine.stationFlows;
      return savedLine;
    }),
  };
}

function makeEmptySnapshot(stations: readonly Station[], pairCount: number): TransitSummarySnapshot {
  return {
    gameTimeMs: 0,
    gameDay: 0,
    currentPeriodId: SIMULATION_BALANCE.periods[0]!.id,
    pathRecomputeCount: 0,
    demandPairCount: pairCount,
    city: {
      gameDay: 0,
      dailyRidership: 0,
      potentialTrips: 0,
      transitShare: 0,
      deniedBoardings: 0,
      transfers: 0,
      quality: null,
      fareRevenue: 0,
      operatingCost: 0,
      profitLossRatio: 0,
    },
    stations: [...stations]
      .sort((a, b) => compareText(a.id, b.id))
      .map((station) => ({
        stationId: station.id,
        name: station.name,
        entries: 0,
        exits: 0,
        entriesExits: 0,
        peakPlatformWaiting: 0,
        deniedBoardings: 0,
        transfers: 0,
        lineIds: [],
        last7DaysEntriesExits: [],
      })),
    lines: [],
  };
}

function lineMetrics(runtime: TransitGraphRuntime, lineId: string): LineRuntimeMetrics {
  return runtime.lineMetrics.get(lineId)!;
}

/**
 * Pure deterministic transit simulation. Call advance() with game milliseconds;
 * setNetwork() invalidates the network-derived paths and demand allocation.
 */
export class TransitSim {
  private readonly demand: VillageDemandModel;
  private readonly villageFingerprint: string;
  private readonly periodsById: ReadonlyMap<SimulationPeriodId, (typeof SIMULATION_BALANCE.periods)[number]>;
  private readonly countyCodes: string[];
  private readonly villageCountyIndex: Uint16Array;
  private networkState: Network;
  private graph: TransitGraphRuntime | undefined;
  private villageAccess: WalkAccess[][] = [];
  private villageToStationCache = new Map<SimulationPeriodId, VillagePathTable>();
  private stationIndexById = new Map<string, number>();
  private equilibrium: PeriodEquilibrium[] = [];
  private representativeRoutesByPeriod = new Map<SimulationPeriodId, Map<string, RepresentativeTripRoute>>();
  private actualAttempts = new Map<string, number>();
  private gameTime = 0;
  private recomputeCount = 0;
  private dirty = true;
  private restoredDirtyCache = false;
  private latestSnapshot: TransitSummarySnapshot;

  constructor(
    villages: readonly VillageDemandPoint[],
    network: Network = createEmptyNetwork(),
    demandParameters: Partial<DemandParameters> = {},
  ) {
    this.demand = buildVillageDemandModel(villages, demandParameters);
    this.villageFingerprint = fingerprintVillages(this.demand.villages);
    this.periodsById = new Map(SIMULATION_BALANCE.periods.map((period) => [period.id, period] as const));
    this.countyCodes = [...new Set(this.demand.villages.map(({ code }) => countyOfVillage(code)))].sort(compareText);
    const countyIndexByCode = new Map(this.countyCodes.map((code, index) => [code, index]));
    this.villageCountyIndex = Uint16Array.from(this.demand.villages, ({ code }) => countyIndexByCode.get(countyOfVillage(code))!);
    this.networkState = copyNetwork(network);
    this.latestSnapshot = makeEmptySnapshot(this.networkState.stations, this.demand.pairs.length);
  }

  get demandPairCount(): number {
    return this.demand.pairs.length;
  }

  /** Returns the highest-flow equilibrium route through a station for the current game period. */
  representativePassenger(stationId: string): RepresentativePassenger | null {
    this.ensurePrepared();
    const route = this.representativeRoutesByPeriod.get(periodAt(this.gameTime))?.get(stationId);
    return route ? selectRepresentativeTrip([route], stationId) : null;
  }

  get pathRecomputeCount(): number {
    return this.recomputeCount;
  }

  get network(): Network {
    return copyNetwork(this.networkState);
  }

  setNetwork(network: Network): void {
    this.networkState = copyNetwork(network);
    this.dirty = true;
    this.restoredDirtyCache = false;
  }

  advance(gameMs: number): TransitSummarySnapshot {
    if (!Number.isFinite(gameMs) || gameMs < 0) {
      throw new RangeError('gameMs must be a non-negative finite number.');
    }
    this.ensurePrepared();
    let remaining = gameMs;
    while (remaining > 0) {
      const offsetInDay = this.gameTime % GAME_DAY_MS;
      const untilNextDay = GAME_DAY_MS - offsetInDay;
      const step = Math.min(remaining, untilNextDay);
      this.gameTime += step;
      remaining -= step;
      if (this.gameTime % GAME_DAY_MS === 0) this.finishGameDay();
    }
    return this.snapshot();
  }

  /** Prepares dirty network-derived paths and refreshes the current summary without advancing time. */
  refresh(): TransitSummarySnapshot {
    this.ensurePrepared();
    this.latestSnapshot = this.summarizeDay(Math.floor(this.gameTime / GAME_DAY_MS), false);
    return this.snapshot();
  }

  snapshot(): TransitSummarySnapshot {
    const snapshot = cloneSnapshot(this.latestSnapshot);
    snapshot.gameTimeMs = this.gameTime;
    snapshot.gameDay = Math.floor(this.gameTime / GAME_DAY_MS);
    snapshot.currentPeriodId = periodAt(this.gameTime);
    snapshot.pathRecomputeCount = this.recomputeCount;
    snapshot.demandPairCount = this.demand.pairs.length;
    return snapshot;
  }

  /** Returns copied per-line flow data, optionally for a single line. */
  lineFlows(lineId?: string): LineFlowsData[] {
    return this.snapshot().lines
      .filter((line) => lineId === undefined || line.lineId === lineId)
      .map(({ lineId: id, stationCount, sectionFlow, stationFlows }) => ({
        lineId: id,
        stationCount,
        sectionFlow,
        stationFlows,
      }));
  }

  serialize(): TransitSimSerializedState {
    const snapshot = this.snapshot();
    return {
      version: 1,
      villageFingerprint: this.villageFingerprint,
      network: copyNetwork(this.networkState),
      gameTimeMs: this.gameTime,
      pathRecomputeCount: this.recomputeCount,
      actualAttempts: [...this.actualAttempts.entries()]
        .sort(([a], [b]) => compareText(a, b))
        .map(([key, trips]) => ({ key, trips })),
      snapshot: snapshotWithoutFlows(snapshot),
    };
  }

  /** Loading is followed by a worker refresh, which recalculates the line flows. */
  static restore(
    villages: readonly VillageDemandPoint[],
    state: TransitSimSerializedState,
    demandParameters: Partial<DemandParameters> = {},
  ): TransitSim {
    if (state.version !== 1) throw new RangeError(`Unsupported transit save version: ${String(state.version)}`);
    const restored = new TransitSim(villages, state.network, demandParameters);
    if (state.villageFingerprint !== restored.villageFingerprint) {
      throw new RangeError('Transit save does not match the supplied village demand dataset.');
    }
    if (!Number.isFinite(state.gameTimeMs) || state.gameTimeMs < 0
      || !Number.isSafeInteger(state.pathRecomputeCount) || state.pathRecomputeCount < 0) {
      throw new RangeError('Invalid serialized transit simulation state.');
    }
    restored.gameTime = state.gameTimeMs;
    restored.recomputeCount = state.pathRecomputeCount;
    restored.actualAttempts = new Map(state.actualAttempts.map(({ key, trips }) => {
      if (!Number.isFinite(trips) || trips < 0) throw new RangeError(`Invalid saved rider amount for ${key}.`);
      return [key, trips];
    }));
    restored.latestSnapshot = cloneSnapshot(state.snapshot);
    restored.dirty = true;
    // Rehydrate derived caches after restart without counting a network edit.
    restored.restoredDirtyCache = true;
    return restored;
  }

  private ensurePrepared(): void {
    if (!this.dirty) return;
    this.graph = buildTransitGraph(this.networkState);
    this.networkState = copyNetwork(this.graph.network);
    this.villageAccess = precomputeVillageAccess(this.demand.villages, this.graph);
    this.villageToStationCache = new Map();
    this.stationIndexById = new Map(this.graph.stations.map((station, index) => [station.id, index]));
    for (const group of SERVICE_PERIOD_GROUPS) {
      const table = this.demand.villages.map(() => new Array<VillageToStationPath | null | undefined>(this.graph!.stations.length));
      for (const periodId of group.periods) this.villageToStationCache.set(periodId, table);
    }
    this.equilibrium = this.buildEquilibrium();
    this.dirty = false;
    if (!this.restoredDirtyCache) this.recomputeCount += 1;
    this.restoredDirtyCache = false;
  }

  private villageToStation(
    villageIndex: number,
    destinationStationId: string,
    periodId: SimulationPeriodId,
  ): VillageToStationPath | null {
    const destinationStationIndex = this.stationIndexById.get(destinationStationId);
    if (destinationStationIndex === undefined) return null;
    const cache = this.villageToStationCache.get(periodId)![villageIndex]!;
    const cached = cache[destinationStationIndex];
    if (cached !== undefined) return cached;
    const graph = this.graph!;
    let bestPath: TransitPath | null = null;
    let bestTimeSeconds = 0;
    let bestWalkSeconds = 0;
    for (const access of this.villageAccess[villageIndex]!) {
      const path = shortestStationPath(graph, periodId, access.stationId, destinationStationId);
      if (!path) continue;
      const timeSeconds = access.walkSeconds + path.timeSeconds;
      if (!bestPath || timeSeconds < bestTimeSeconds - 1e-9
        || (Math.abs(timeSeconds - bestTimeSeconds) <= 1e-9 && path.signature < bestPath.signature)) {
        bestPath = path;
        bestTimeSeconds = timeSeconds;
        bestWalkSeconds = access.walkSeconds;
      }
    }
    const best = bestPath ? { path: bestPath, timeSeconds: bestTimeSeconds, walkSeconds: bestWalkSeconds } : null;
    cache[destinationStationIndex] = best;
    return best;
  }

  private bestVillagePairPath(
    originIndex: number,
    destinationIndex: number,
    periodId: SimulationPeriodId,
  ): { path: TransitPath; timeSeconds: number; walkInSeconds: number; walkOutSeconds: number } | null {
    let bestPath: TransitPath | null = null;
    let bestTimeSeconds = 0;
    let bestWalkInSeconds = 0;
    let bestWalkOutSeconds = 0;
    for (const egress of this.villageAccess[destinationIndex]!) {
      const partial = this.villageToStation(originIndex, egress.stationId, periodId);
      if (!partial) continue;
      const timeSeconds = partial.timeSeconds + egress.walkSeconds;
      if (!bestPath || timeSeconds < bestTimeSeconds - 1e-9
        || (Math.abs(timeSeconds - bestTimeSeconds) <= 1e-9
          && partial.path.signature < bestPath.signature)) {
        bestPath = partial.path;
        bestTimeSeconds = timeSeconds;
        bestWalkInSeconds = partial.walkSeconds;
        bestWalkOutSeconds = egress.walkSeconds;
      }
    }
    return bestPath ? {
      path: bestPath,
      timeSeconds: bestTimeSeconds,
      walkInSeconds: bestWalkInSeconds,
      walkOutSeconds: bestWalkOutSeconds,
    } : null;
  }

  private buildEquilibrium(): PeriodEquilibrium[] {
    const byPeriod = new Map<SimulationPeriodId, Map<string, EquilibriumRoute>>();
    const potentialByPeriod = new Map<SimulationPeriodId, number>();
    const reversePathsBySignature = new Map<string, TransitPath>();
    const representativeStationsBySignature = new Map<string, string[]>();
    this.representativeRoutesByPeriod = new Map();
    for (const period of SIMULATION_BALANCE.periods) {
      const id = period.id;
      byPeriod.set(id, new Map());
      potentialByPeriod.set(id, this.demand.totalDailyTrips * period.demandShare);
      this.representativeRoutesByPeriod.set(id, new Map());
    }
    const hasReachableStation = this.villageAccess.some((access) => access.length > 0);
    if (this.demand.totalDirectedGravityWeight > 0 && this.graph && hasReachableStation) {
      for (const pair of this.demand.pairs) {
        if (this.villageAccess[pair.first]!.length === 0 || this.villageAccess[pair.second]!.length === 0) continue;
        const dailyTripsEachDirection = pair.gravityWeight / this.demand.totalDirectedGravityWeight
          * this.demand.totalDailyTrips;
        this.addPairDemand(
          pair.first,
          pair.second,
          pair.distanceKm,
          dailyTripsEachDirection,
          byPeriod,
          reversePathsBySignature,
          representativeStationsBySignature,
        );
      }
    }
    return SIMULATION_BALANCE.periods.map(({ id }) => ({
      periodId: id,
      potentialTrips: potentialByPeriod.get(id)!,
      routes: [...byPeriod.get(id)!.entries()]
        .sort(([a], [b]) => compareText(a, b))
        .map(([, route]) => route),
    }));
  }

  private addPairDemand(
    originIndex: number,
    destinationIndex: number,
    distanceKm: number,
    dailyTrips: number,
    rowsByPeriod: Map<SimulationPeriodId, Map<string, EquilibriumRoute>>,
    reversePathsBySignature: Map<string, TransitPath>,
    representativeStationsBySignature: Map<string, string[]>,
  ): void {
    const alternativeTime = distanceKm / SIMULATION_BALANCE.alternativeMode.speedKmh * 3_600
      + SIMULATION_BALANCE.alternativeMode.fixedTimeSeconds;
    for (const group of SERVICE_PERIOD_GROUPS) {
      const best = this.bestVillagePairPath(originIndex, destinationIndex, group.representative);
      const shares = binaryLogitShares(best?.timeSeconds ?? null, alternativeTime);
      if (!best || shares.transit <= 0) continue;
      const origin = this.demand.villages[originIndex]!;
      const destination = this.demand.villages[destinationIndex]!;
      let reversePath = reversePathsBySignature.get(best.path.signature);
      if (!reversePath) {
        reversePath = reverseTransitPath(best.path);
        reversePathsBySignature.set(best.path.signature, reversePath);
      }
      const directions = [
        { path: best.path, originIndex, destinationIndex, origin, destination, walkInSeconds: best.walkInSeconds, walkOutSeconds: best.walkOutSeconds },
        { path: reversePath, originIndex: destinationIndex, destinationIndex: originIndex, origin: destination, destination: origin,
          walkInSeconds: best.walkOutSeconds, walkOutSeconds: best.walkInSeconds },
      ];
      const periodContexts = group.periods.map((periodId) => ({
        periodId,
        period: this.periodsById.get(periodId)!,
        rows: rowsByPeriod.get(periodId)!,
        stationRoutes: this.representativeRoutesByPeriod.get(periodId)!,
      }));
      for (const { periodId, period, rows, stationRoutes } of periodContexts) {
        const potentialTrips = dailyTrips * period.demandShare;
        const desiredTrips = potentialTrips * shares.transit;
        if (desiredTrips <= 0) continue;
        const fareTotal = desiredTrips * fareForDistance(distanceKm);
        for (const direction of directions) {
          const path = direction.path;
          const existing = rows.get(path.signature);
          if (existing) {
            existing.desiredTrips += desiredTrips;
            existing.fareTotal += fareTotal;
            const originCountyIndex = this.villageCountyIndex[direction.originIndex]!;
            const destinationCountyIndex = this.villageCountyIndex[direction.destinationIndex]!;
            addIndexedCountyFlow(
              existing.countyFlows,
              originCountyIndex * this.countyCodes.length + destinationCountyIndex,
              desiredTrips,
              fareTotal,
            );
          } else {
            const route: EquilibriumRoute = {
              path,
              desiredTrips,
              fareTotal,
              countyFlows: new Map<number, CountyFlowTotals>(),
            };
            const originCountyIndex = this.villageCountyIndex[direction.originIndex]!;
            const destinationCountyIndex = this.villageCountyIndex[direction.destinationIndex]!;
            addIndexedCountyFlow(
              route.countyFlows,
              originCountyIndex * this.countyCodes.length + destinationCountyIndex,
              desiredTrips,
              fareTotal,
            );
            rows.set(path.signature, route);
          }
          const odKey = `${direction.origin.code}>${direction.destination.code}`;
          const routeOrder = { odKey, flow: desiredTrips, periodId, pathSignature: path.signature };
          let routeStationIds = representativeStationsBySignature.get(path.signature);
          if (!routeStationIds) {
            routeStationIds = representativeStationIds(path, this.graph!);
            representativeStationsBySignature.set(path.signature, routeStationIds);
          }
          let hasWinningStation = false;
          for (const stationId of routeStationIds) {
            const selected = stationRoutes.get(stationId);
            if (!selected || compareRepresentativeTripRouteKeys(routeOrder, representativeTripRouteOrder(selected)) < 0) {
              hasWinningStation = true;
              break;
            }
          }
          if (hasWinningStation) {
            const winningStations: string[] = [];
            for (const stationId of routeStationIds) {
              const selected = stationRoutes.get(stationId);
              if (!selected || compareRepresentativeTripRouteKeys(routeOrder, representativeTripRouteOrder(selected)) < 0) {
                winningStations.push(stationId);
              }
            }
            const candidate: RepresentativeTripRoute = {
              odKey,
              flow: desiredTrips,
              periodId,
              path: buildRepresentativeTripPath(
                path,
                this.graph!,
                periodId,
                direction.walkInSeconds,
                direction.walkOutSeconds,
                alternativeTime,
                routeStationIds,
              ),
            };
            for (const stationId of winningStations) stationRoutes.set(stationId, candidate);
          }
        }
      }
    }
  }

  private finishGameDay(): void {
    this.ensurePrepared();
    const habitFraction = 1 - Math.exp(-1 / SIMULATION_BALANCE.habitTimeConstantDays);
    const nextAttempts = new Map<string, number>();
    for (const period of this.equilibrium) {
      for (const route of period.routes) {
        const key = routeStateKey(period.periodId, route.path.signature);
        const actual = this.actualAttempts.get(key) ?? 0;
        const approached = actual + (route.desiredTrips - actual) * habitFraction;
        nextAttempts.set(key, approached);
      }
    }
    this.actualAttempts = nextAttempts;
    this.latestSnapshot = this.summarizeDay(Math.floor(this.gameTime / GAME_DAY_MS));
  }

  private buildPeriodLoads(periodId: SimulationPeriodId, routes: readonly EquilibriumRoute[]): PeriodLoadData {
    const graph = this.graph!;
    const period = SIMULATION_BALANCE.periods.find(({ id }) => id === periodId)!;
    const attemptedLoadBySegment = new Map<string, number>();
    const periodCapacityBySegment = new Map<string, number>();
    const operatingCostByLine = new Map<string, number>();
    const hourlyCapacityByLine = new Map<string, number>();
    for (const line of graph.lines) {
      const hourlyCapacity = lineHourlyCapacity(line, graph.stations, periodId);
      const periodCapacity = hourlyCapacity * period.durationHours;
      hourlyCapacityByLine.set(line.id, hourlyCapacity);
      operatingCostByLine.set(
        line.id,
        trainsForPeriod(line, periodId) * period.durationHours * TRANSIT_MODES[line.mode].operatingCostPerTrainHour,
      );
      for (let segmentIndex = 0; segmentIndex + 1 < line.stationIds.length; segmentIndex += 1) {
        for (const direction of [1, -1] as const) {
          periodCapacityBySegment.set(segmentKey(line.id, segmentIndex, direction), periodCapacity);
        }
      }
    }
    for (const route of routes) {
      const actual = this.actualAttempts.get(routeStateKey(periodId, route.path.signature)) ?? 0;
      for (const leg of route.path.legs) {
        for (const segment of leg.segments) {
          const key = segmentKey(segment.lineId, segment.segmentIndex, segment.direction);
          attemptedLoadBySegment.set(key, (attemptedLoadBySegment.get(key) ?? 0) + actual);
        }
      }
    }
    return { periodId, periodCapacityBySegment, attemptedLoadBySegment, operatingCostByLine, hourlyCapacityByLine };
  }

  private summarizeDay(gameDay: number, appendHistory = true): TransitSummarySnapshot {
    const graph = this.graph!;
    const stationAccumulators = new Map<string, StationAccumulator>();
    for (const station of graph.stations) {
      stationAccumulators.set(station.id, {
        entries: 0,
        exits: 0,
        denied: 0,
        transfers: 0,
        waitByPeriod: new Map(),
      });
    }

    const loadData = this.equilibrium.map((period) => this.buildPeriodLoads(period.periodId, period.routes));
    const maxLoadFactorByPeriodLine = new Map<SimulationPeriodId, Map<string, number>>();
    const sectionFlowByPeriod = new Map<SimulationPeriodId, Map<string, LineSectionFlowPeriod>>();
    const stationFlowsByPeriod = new Map<SimulationPeriodId, Map<string, LineStationFlowAccumulator>>();
    let dailyRidership = 0;
    let totalPotentialTrips = 0;
    let deniedBoardings = 0;
    let transfers = 0;
    let fareRevenue = 0;
    let operatingCost = 0;
    const cityCountyFlows = new Map<number, CountyFlowTotals>();
    const cityQuality = emptyQualityAccumulator();
    const lineQuality = new Map(graph.lines.map((line) => [line.id, emptyQualityAccumulator()]));

    for (const period of this.equilibrium) {
      const periodConfig = SIMULATION_BALANCE.periods.find(({ id }) => id === period.periodId)!;
      const periodLoads = loadData.find(({ periodId }) => periodId === period.periodId)!;
      const acceptedLoads = new Map<string, number>();
      const acceptedPathLoads: Array<{
        passengers: number;
        segments: Array<{ lineId: string; key: string }>;
      }> = [];
      const stationFlows = new Map<string, LineStationFlowAccumulator>();
      for (const line of graph.lines) {
        stationFlows.set(line.id, {
          forward: {
            boardings: Array<number>(line.stationIds.length).fill(0),
            alightings: Array<number>(line.stationIds.length).fill(0),
          },
          backward: {
            boardings: Array<number>(line.stationIds.length).fill(0),
            alightings: Array<number>(line.stationIds.length).fill(0),
          },
        });
      }
      const maxFactors = new Map<string, number>();
      for (const line of graph.lines) maxFactors.set(line.id, 0);
      totalPotentialTrips += period.potentialTrips;
      for (const route of period.routes) {
        const key = routeStateKey(period.periodId, route.path.signature);
        const attempted = this.actualAttempts.get(key) ?? 0;
        let acceptedFactor = 1;
        for (const leg of route.path.legs) {
          for (const segment of leg.segments) {
            const loadKey = segmentKey(segment.lineId, segment.segmentIndex, segment.direction);
            const load = periodLoads.attemptedLoadBySegment.get(loadKey) ?? 0;
            const capacity = periodLoads.periodCapacityBySegment.get(loadKey) ?? 0;
            if (load > capacity && load > 0) acceptedFactor = Math.min(acceptedFactor, capacity / load);
          }
        }
        // Each path's riders are scaled by its tightest segment's capacity ratio.
        // That records denied boardings proportionally without random allocation.
        const accepted = attempted * acceptedFactor;
        const ratio = route.desiredTrips > 0 ? accepted / route.desiredTrips : 0;
        const sortedCountyFlows = [...route.countyFlows.entries()].sort(([a], [b]) => a - b);
        for (const [pairIndex, flow] of sortedCountyFlows) {
          const trips = flow.trips * ratio;
          const fareRevenue = flow.fareRevenue * ratio;
          addIndexedCountyFlow(cityCountyFlows, pairIndex, trips, fareRevenue);
        }
        const denied = attempted - accepted;
        dailyRidership += accepted;
        deniedBoardings += denied;
        fareRevenue += accepted * (route.desiredTrips > 0 ? route.fareTotal / route.desiredTrips : 0);
        if (denied > 0) {
          const firstStation = route.path.legs[0]!.fromStationId;
          stationAccumulators.get(firstStation)!.denied += denied;
        }
        transfers += accepted * route.path.transfers;
        cityQuality.passengers += accepted;
        cityQuality.attempted += attempted;
        cityQuality.denied += denied;
        cityQuality.transfers += accepted * route.path.transfers;
        const routeLineIds = new Set(route.path.legs.map(({ lineId }) => lineId));
        for (const lineId of routeLineIds) {
          const accumulator = lineQuality.get(lineId)!;
          accumulator.passengers += accepted;
          accumulator.attempted += attempted;
          accumulator.denied += denied;
          accumulator.transfers += accepted * route.path.transfers;
        }

        for (const leg of route.path.legs) {
          const firstSegment = leg.segments[0]!;
          const lastSegment = leg.segments[leg.segments.length - 1]!;
          const direction = firstSegment.direction === 1 ? 'forward' : 'backward';
          const boardingIndex = firstSegment.direction === 1
            ? firstSegment.segmentIndex
            : firstSegment.segmentIndex + 1;
          const alightingIndex = firstSegment.direction === 1
            ? lastSegment.segmentIndex + 1
            : lastSegment.segmentIndex;
          const stationFlow = stationFlows.get(leg.lineId)![direction];
          stationFlow.boardings[boardingIndex] = stationFlow.boardings[boardingIndex]! + accepted;
          stationFlow.alightings[alightingIndex] = stationFlow.alightings[alightingIndex]! + accepted;
          const from = stationAccumulators.get(leg.fromStationId);
          const to = stationAccumulators.get(leg.toStationId);
          if (from) from.entries += accepted;
          if (to) to.exits += accepted;
          const headway = lineMetrics(graph, leg.lineId).headwaySeconds[period.periodId];
          if (Number.isFinite(headway)) {
            const waitMinutes = headway / 120;
            cityQuality.waitMinutes += accepted * waitMinutes;
            lineQuality.get(leg.lineId)!.waitMinutes += accepted * waitMinutes;
          }
          if (periodConfig.usesPeakTrains && accepted > 0) {
            if (Number.isFinite(headway)) {
              const estimatedWaiting = accepted / periodConfig.durationHours * headway / 2 / 3_600;
              from?.waitByPeriod.set(
                period.periodId,
                (from.waitByPeriod.get(period.periodId) ?? 0) + estimatedWaiting,
              );
            }
          }
        }
        for (let legIndex = 1; legIndex < route.path.legs.length; legIndex += 1) {
          const transferStationId = route.path.legs[legIndex]!.fromStationId;
          const station = stationAccumulators.get(transferStationId);
          if (station) station.transfers += accepted;
        }
        const pathSegments: Array<{ lineId: string; key: string }> = [];
        for (const leg of route.path.legs) {
          for (const segment of leg.segments) {
            const loadKey = segmentKey(segment.lineId, segment.segmentIndex, segment.direction);
            acceptedLoads.set(loadKey, (acceptedLoads.get(loadKey) ?? 0) + accepted);
            pathSegments.push({ lineId: segment.lineId, key: loadKey });
          }
        }
        acceptedPathLoads.push({ passengers: accepted, segments: pathSegments });
      }

      for (const line of graph.lines) {
        const hourlyCapacity = periodLoads.hourlyCapacityByLine.get(line.id) ?? 0;
        const periodCapacity = hourlyCapacity * periodConfig.durationHours;
        let maxFactor = 0;
        for (let segmentIndex = 0; segmentIndex + 1 < line.stationIds.length; segmentIndex += 1) {
          for (const direction of [1, -1] as const) {
            const loadKey = segmentKey(line.id, segmentIndex, direction);
            const load = acceptedLoads.get(loadKey) ?? 0;
            const loadFactor = periodCapacity > 0 ? load / periodCapacity : 0;
            if (periodCapacity > 0) maxFactor = Math.max(maxFactor, loadFactor);
          }
        }
        maxFactors.set(line.id, maxFactor);
        operatingCost += periodLoads.operatingCostByLine.get(line.id) ?? 0;
      }
      const crowding = summarizePathCrowding(acceptedPathLoads.map((path) => ({
        passengers: path.passengers,
        segments: path.segments.map(({ lineId, key }) => {
          const capacity = periodLoads.periodCapacityBySegment.get(key) ?? 0;
          const load = acceptedLoads.get(key) ?? 0;
          return { lineId, loadFactor: capacity > 0 ? load / capacity : 0 };
        }),
      })));
      cityQuality.weightedLoadFactor += crowding.weightedLoadFactor * crowding.passengerCount;
      cityQuality.loadFactorPassengers += crowding.passengerCount;
      for (const [lineId, lineCrowding] of crowding.byLine) {
        const accumulator = lineQuality.get(lineId);
        if (!accumulator) continue;
        accumulator.weightedLoadFactor += lineCrowding.weightedLoadFactor * lineCrowding.passengerCount;
        accumulator.loadFactorPassengers += lineCrowding.passengerCount;
      }
      const sectionFlows = new Map<string, LineSectionFlowPeriod>();
      for (const line of graph.lines) {
        const sectionFlow: LineSectionFlowPeriod = { forward: [], backward: [] };
        for (let segmentIndex = 0; segmentIndex + 1 < line.stationIds.length; segmentIndex += 1) {
          for (const [direction, directionId] of [['forward', 1], ['backward', -1]] as const) {
            const key = segmentKey(line.id, segmentIndex, directionId);
            const load = acceptedLoads.get(key) ?? 0;
            const capacity = periodLoads.periodCapacityBySegment.get(key) ?? 0;
            sectionFlow[direction].push({
              load,
              capacity,
              loadFactor: capacity > 0 ? load / capacity : 0,
            });
          }
        }
        sectionFlows.set(line.id, sectionFlow);
      }
      sectionFlowByPeriod.set(period.periodId, sectionFlows);
      stationFlowsByPeriod.set(period.periodId, stationFlows);
      maxLoadFactorByPeriodLine.set(period.periodId, maxFactors);
    }

    const stations = graph.stations.map((station) => {
      const accumulated = stationAccumulators.get(station.id)!;
      const entriesExits = accumulated.entries + accumulated.exits;
      const prior = this.latestSnapshot.stations.find(({ stationId }) => stationId === station.id);
      const lineIds = graph.lines
        .filter((line) => line.stationIds.includes(station.id))
        .map(({ id }) => id)
        .sort(compareText);
      return {
        stationId: station.id,
        name: station.name,
        entries: accumulated.entries,
        exits: accumulated.exits,
        entriesExits,
        peakPlatformWaiting: Math.max(
          accumulated.waitByPeriod.get('morningPeak') ?? 0,
          accumulated.waitByPeriod.get('eveningPeak') ?? 0,
        ),
        deniedBoardings: accumulated.denied,
        transfers: accumulated.transfers,
        lineIds,
        last7DaysEntriesExits: appendHistory
          ? [...(prior?.last7DaysEntriesExits ?? []), entriesExits].slice(-7)
          : [...(prior?.last7DaysEntriesExits ?? [])],
      };
    });

    const lines = graph.lines.map((line) => {
      const metrics = lineMetrics(graph, line.id);
      const periods = SIMULATION_BALANCE.periods.map((period) => {
        const loadFactor = maxLoadFactorByPeriodLine.get(period.id)!.get(line.id) ?? 0;
        const hourlyCapacity = lineHourlyCapacity(line, graph.stations, period.id);
        return {
          periodId: period.id,
          periodName: period.name,
          maxLoadFactor: loadFactor,
          operatingCost: loadData.find(({ periodId }) => periodId === period.id)!.operatingCostByLine.get(line.id) ?? 0,
          roundTripTimeSeconds: metrics.roundTripSeconds,
          headwaySeconds: Number.isFinite(metrics.headwaySeconds[period.id])
            ? metrics.headwaySeconds[period.id]
            : null,
          hourlyCapacity,
          periodCapacity: hourlyCapacity * period.durationHours,
        };
      });
      return {
        lineId: line.id,
        name: line.name,
        mode: line.mode,
        stationCount: line.stationIds.length,
        lengthKm: metrics.lengthKm,
        cars: line.cars,
        peakTrains: line.peakTrains,
        offPeakTrains: line.offPeakTrains,
        spacingWarnings: lineSpacingWarnings(line, graph.stations),
        periods,
        sectionFlow: Object.fromEntries(SIMULATION_BALANCE.periods.map(({ id }) => [
          id,
          sectionFlowByPeriod.get(id)!.get(line.id)!,
        ])) as Record<SimulationPeriodId, LineSectionFlowPeriod>,
        stationFlows: Object.fromEntries(SIMULATION_BALANCE.periods.map(({ id }) => {
          const flow = stationFlowsByPeriod.get(id)!.get(line.id)!;
          return [id, {
            forward: {
              boardings: [...flow.forward.boardings],
              alightings: [...flow.forward.alightings],
            },
            backward: {
              boardings: [...flow.backward.boardings],
              alightings: [...flow.backward.alightings],
            },
          }];
        })) as Record<SimulationPeriodId, LineStationFlowPeriod>,
        quality: qualityFromAccumulator(lineQuality.get(line.id)!),
      };
    });

    const transitShare = totalPotentialTrips > 0 ? dailyRidership / totalPotentialTrips : 0;
    return {
      gameTimeMs: this.gameTime,
      gameDay,
      currentPeriodId: periodAt(this.gameTime),
      pathRecomputeCount: this.recomputeCount,
      demandPairCount: this.demand.pairs.length,
      city: {
        gameDay,
        dailyRidership,
        potentialTrips: totalPotentialTrips,
        transitShare,
        deniedBoardings,
        transfers,
        quality: qualityFromAccumulator(cityQuality),
        fareRevenue,
        countyFlows: summarizeCountyFlows([...cityCountyFlows.entries()].map(([pairIndex, flow]) => ({
          originCounty: this.countyCodes[Math.floor(pairIndex / this.countyCodes.length)]!,
          destinationCounty: this.countyCodes[pairIndex % this.countyCodes.length]!,
          trips: flow.trips,
          fareRevenue: flow.fareRevenue,
        }))).flows,
        operatingCost,
        profitLossRatio: operatingCost > 0 ? (fareRevenue - operatingCost) / operatingCost : 0,
      },
      stations,
      lines,
    };
  }
}

