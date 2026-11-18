import { haversineKm } from '../../city/network';
import { SIMULATION_BALANCE, TRANSIT_MODES, type SimulationPeriodId } from '../../city/modes';
import { compareText } from '../compare';
import type { TransitGraphRuntime, TransitPath } from './graph';

export type RepresentativeLegKind = 'walkIn' | 'wait' | 'ride' | 'transfer' | 'walkOut';

export interface RepresentativePassengerLeg {
  kind: RepresentativeLegKind;
  minutes: number;
  lineId?: string;
  fromStationId?: string;
  toStationId?: string;
  viaStationIds?: string[];
}

/** Timing details attached to one equilibrium path for the requested period. */
export interface RepresentativeTripPath {
  transitPath: TransitPath;
  stationIds: string[];
  rideStationIds: string[][];
  walkInSeconds: number;
  waitSeconds: number[];
  rideSeconds: number[];
  transferSeconds: number[];
  walkOutSeconds: number;
  alternativeSeconds: number | null;
}

export interface RepresentativeTripRoute {
  odKey: string;
  flow: number;
  periodId: SimulationPeriodId;
  path: RepresentativeTripPath;
}

export interface RepresentativeTripRouteOrder {
  odKey: string;
  flow: number;
  periodId: SimulationPeriodId;
  pathSignature: string;
}

export interface RepresentativePassenger {
  selectedStationId: string;
  odKey: string;
  flow: number;
  startStationId: string;
  endStationId: string;
  pathSignature: string;
  legs: RepresentativePassengerLeg[];
  doorToDoorMinutes: number;
  alternativeMinutes: number | null;
}

/** Derives the established graph costs into named trip segments; balance values stay in modes.ts. */
export function buildRepresentativeTripPath(
  transitPath: TransitPath,
  graph: TransitGraphRuntime,
  periodId: SimulationPeriodId,
  walkInSeconds: number,
  walkOutSeconds: number,
  alternativeSeconds: number | null,
  stationIds = representativeStationIds(transitPath, graph),
): RepresentativeTripPath {
  const waitSeconds = transitPath.legs.map((leg) => {
    const metrics = graph.lineMetrics.get(leg.lineId);
    if (!metrics) throw new RangeError(`Unknown line in representative path: ${leg.lineId}`);
    return metrics.headwaySeconds[periodId] / 2;
  });
  const rideSeconds = transitPath.legs.map((leg) => {
    const metrics = graph.lineMetrics.get(leg.lineId);
    if (!metrics) throw new RangeError(`Unknown line in representative path: ${leg.lineId}`);
    const mode = TRANSIT_MODES[metrics.line.mode];
    return leg.segments.reduce((total, segment) => {
      const fromIndex = segment.direction === 1 ? segment.segmentIndex : segment.segmentIndex + 1;
      const toIndex = segment.direction === 1 ? segment.segmentIndex + 1 : segment.segmentIndex;
      const from = graph.stationById.get(metrics.line.stationIds[fromIndex]!);
      const to = graph.stationById.get(metrics.line.stationIds[toIndex]!);
      if (!from || !to) throw new RangeError(`Invalid segment in representative path: ${leg.lineId}`);
      const travelSeconds = haversineKm(from.lon, from.lat, to.lon, to.lat) / mode.avgSpeedKmh * 3_600;
      return total + travelSeconds + mode.dwellSecondsPerStop;
    }, 0);
  });
  const rideStationIds = transitPath.legs.map((leg) => representativeRideStationIds(leg, graph));
  const transferSeconds = transitPath.legs.slice(1).map(() => SIMULATION_BALANCE.transferPenaltySeconds);
  return {
    transitPath,
    stationIds,
    rideStationIds,
    walkInSeconds,
    waitSeconds,
    rideSeconds,
    transferSeconds,
    walkOutSeconds,
    alternativeSeconds,
  };
}

function representativeRideStationIds(
  leg: TransitPath['legs'][number],
  graph: TransitGraphRuntime,
): string[] {
  const line = graph.lineMetrics.get(leg.lineId)?.line;
  if (!line) throw new RangeError(`Unknown line in representative path: ${leg.lineId}`);
  const stationIds: string[] = [];
  for (const segment of leg.segments) {
    const fromIndex = segment.direction === 1 ? segment.segmentIndex : segment.segmentIndex + 1;
    const toIndex = segment.direction === 1 ? segment.segmentIndex + 1 : segment.segmentIndex;
    const fromStationId = line.stationIds[fromIndex];
    const toStationId = line.stationIds[toIndex];
    if (!fromStationId || !toStationId || (stationIds.length > 0 && stationIds[stationIds.length - 1] !== fromStationId)) {
      throw new RangeError(`Invalid segment in representative path: ${leg.lineId}`);
    }
    if (stationIds.length === 0) stationIds.push(fromStationId);
    stationIds.push(toStationId);
  }
  return stationIds;
}

/** Returns every station visited by the ordered ride segments, including transfer stops. */
export function representativeStationIds(transitPath: TransitPath, graph: TransitGraphRuntime): string[] {
  const stationIds = [transitPath.startStationId];
  for (const leg of transitPath.legs) {
    const line = graph.lineMetrics.get(leg.lineId)?.line;
    if (!line) throw new RangeError(`Unknown line in representative path: ${leg.lineId}`);
    for (const segment of leg.segments) {
      const toIndex = segment.direction === 1 ? segment.segmentIndex + 1 : segment.segmentIndex;
      const stationId = line.stationIds[toIndex];
      if (!stationId) throw new RangeError(`Invalid segment in representative path: ${leg.lineId}`);
      if (stationIds[stationIds.length - 1] !== stationId) stationIds.push(stationId);
    }
  }
  return stationIds;
}

/** Converts the stored route costs into walk, wait, ride and transfer legs in game minutes. */
export function tripLegs(path: RepresentativeTripPath): RepresentativePassengerLeg[] {
  const legs: RepresentativePassengerLeg[] = [
    { kind: 'walkIn', minutes: path.walkInSeconds / 60, toStationId: path.transitPath.startStationId },
  ];
  for (let index = 0; index < path.transitPath.legs.length; index += 1) {
    const ride = path.transitPath.legs[index]!;
    legs.push({
      kind: 'wait',
      minutes: path.waitSeconds[index]! / 60,
      lineId: ride.lineId,
      fromStationId: ride.fromStationId,
      toStationId: ride.fromStationId,
    });
    legs.push({
      kind: 'ride',
      minutes: path.rideSeconds[index]! / 60,
      lineId: ride.lineId,
      fromStationId: ride.fromStationId,
      toStationId: ride.toStationId,
      viaStationIds: path.rideStationIds[index],
    });
    if (index < path.transferSeconds.length) {
      legs.push({
        kind: 'transfer',
        minutes: path.transferSeconds[index]! / 60,
        fromStationId: ride.toStationId,
        toStationId: ride.toStationId,
      });
    }
  }
  legs.push({ kind: 'walkOut', minutes: path.walkOutSeconds / 60, fromStationId: path.transitPath.endStationId });
  return legs;
}

/** Lower comparator result is the deterministic representative route winner. */
export function compareRepresentativeTripRouteKeys(a: RepresentativeTripRouteOrder, b: RepresentativeTripRouteOrder): number {
  if (a.flow !== b.flow) return a.flow > b.flow ? -1 : 1;
  return compareText(a.odKey, b.odKey)
    || compareText(a.pathSignature, b.pathSignature)
    || compareText(a.periodId, b.periodId);
}

export function representativeTripRouteOrder(route: RepresentativeTripRoute): RepresentativeTripRouteOrder {
  return {
    odKey: route.odKey,
    flow: route.flow,
    periodId: route.periodId,
    pathSignature: route.path.transitPath.signature,
  };
}

export function selectRepresentativeTrip(
  routes: readonly RepresentativeTripRoute[],
  stationId: string,
): RepresentativePassenger | null {
  let chosen: RepresentativeTripRoute | undefined;
  for (const route of routes) {
    if (!route.path.stationIds.includes(stationId)) continue;
    if (!chosen || compareRepresentativeTripRouteKeys(
      representativeTripRouteOrder(route), representativeTripRouteOrder(chosen),
    ) < 0) chosen = route;
  }
  if (!chosen) return null;
  const transitPath = chosen.path.transitPath;
  const doorToDoorSeconds = chosen.path.walkInSeconds + transitPath.timeSeconds + chosen.path.walkOutSeconds;
  return {
    selectedStationId: stationId,
    odKey: chosen.odKey,
    flow: chosen.flow,
    startStationId: transitPath.startStationId,
    endStationId: transitPath.endStationId,
    pathSignature: transitPath.signature,
    legs: tripLegs(chosen.path),
    doorToDoorMinutes: doorToDoorSeconds / 60,
    alternativeMinutes: chosen.path.alternativeSeconds === null ? null : chosen.path.alternativeSeconds / 60,
  };
}
