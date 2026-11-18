import type { TrainPosition } from '../sim/protocol';
import type { RepresentativePassenger } from '../sim/transit/representative';
import { haversineKm } from './network';

export type FollowState =
  | { kind: 'idle' }
  | { kind: 'followingTrain'; trainId: string; lineId: string }
  | { kind: 'followingPassenger'; trip: RepresentativePassenger; startGameTime: number }
  | { kind: 'passengerTripEnded'; trip: RepresentativePassenger; startGameTime: number };

export type FollowEvent =
  | { type: 'start'; trainId: string; lineId: string }
  | { type: 'startPassenger'; trip: RepresentativePassenger; startGameTime: number }
  | { type: 'replay'; startGameTime: number }
  | { type: 'close' }
  | { type: 'drag' }
  | { type: 'escape' }
  | { type: 'trainGone'; trainId: string }
  | { type: 'lineDeleted'; lineId: string }
  | { type: 'stationDeleted'; stationId: string }
  | { type: 'tripFinished' };

/** 節奏由小鑫決定，數值不要改。 */
export const PASSENGER_FOLLOW_TIME_SCALE = 1;

export interface FollowTrainDisplay {
  lineId: string;
  lineName: string;
  direction: '順向' | '逆向';
  nextStationName: string;
}

export interface FollowTrainInfo extends FollowTrainDisplay {
  loadFactor?: number;
}

export interface PassengerCoordinate {
  lon: number;
  lat: number;
}

function interpolateStraight(
  from: PassengerCoordinate,
  to: PassengerCoordinate,
  fraction: number,
): PassengerCoordinate {
  return {
    lon: from.lon + (to.lon - from.lon) * fraction,
    lat: from.lat + (to.lat - from.lat) * fraction,
  };
}

function interpolateRide(
  leg: RepresentativePassenger['legs'][number],
  from: PassengerCoordinate,
  to: PassengerCoordinate,
  fraction: number,
  stationCoords: ReadonlyMap<string, PassengerCoordinate>,
): PassengerCoordinate {
  const viaStationIds = leg.viaStationIds;
  if (
    !leg.fromStationId
    || !leg.toStationId
    || !viaStationIds
    || viaStationIds.length < 2
    || viaStationIds[0] !== leg.fromStationId
    || viaStationIds[viaStationIds.length - 1] !== leg.toStationId
  ) return interpolateStraight(from, to, fraction);

  const route = viaStationIds.map((stationId) => stationCoords.get(stationId));
  if (route.some((coordinate) => !coordinate)) return interpolateStraight(from, to, fraction);
  const coordinates = route as PassengerCoordinate[];
  const distances = coordinates.slice(1).map((coordinate, index) => {
    const previous = coordinates[index]!;
    return haversineKm(previous.lon, previous.lat, coordinate.lon, coordinate.lat);
  });
  const totalDistance = distances.reduce((total, distance) => total + distance, 0);
  if (!Number.isFinite(totalDistance) || totalDistance <= 0) return interpolateStraight(from, to, fraction);

  let distanceAlongRoute = totalDistance * fraction;
  for (let index = 0; index < distances.length; index += 1) {
    const segmentDistance = distances[index]!;
    if (distanceAlongRoute <= segmentDistance || index === distances.length - 1) {
      const segmentFraction = segmentDistance === 0 ? 0 : distanceAlongRoute / segmentDistance;
      return interpolateStraight(coordinates[index]!, coordinates[index + 1]!, Math.min(1, segmentFraction));
    }
    distanceAlongRoute -= segmentDistance;
  }
  return { ...to };
}

const IDLE: FollowState = { kind: 'idle' };

export function followReducer(state: FollowState, event: FollowEvent): FollowState {
  if (event.type === 'start') return { kind: 'followingTrain', trainId: event.trainId, lineId: event.lineId };
  if (event.type === 'startPassenger') {
    return { kind: 'followingPassenger', trip: event.trip, startGameTime: event.startGameTime };
  }
  if (state.kind === 'idle') return state;
  if (event.type === 'drag' || event.type === 'escape' || event.type === 'close') return IDLE;
  if (state.kind === 'followingTrain') {
    if (event.type === 'trainGone' && event.trainId === state.trainId) return IDLE;
    if (event.type === 'lineDeleted' && event.lineId === state.lineId) return IDLE;
  }
  if (state.kind === 'followingPassenger') {
    if (event.type === 'tripFinished') {
      return { kind: 'passengerTripEnded', trip: state.trip, startGameTime: state.startGameTime };
    }
    if (event.type === 'stationDeleted' && passengerTripUsesStation(state.trip, event.stationId)) return IDLE;
  }
  if (state.kind === 'passengerTripEnded') {
    if (event.type === 'replay') {
      return { kind: 'followingPassenger', trip: state.trip, startGameTime: event.startGameTime };
    }
    if (event.type === 'stationDeleted' && passengerTripUsesStation(state.trip, event.stationId)) return IDLE;
  }
  return state;
}

function passengerTripUsesStation(trip: RepresentativePassenger, stationId: string): boolean {
  if (trip.selectedStationId === stationId || trip.startStationId === stationId || trip.endStationId === stationId) return true;
  return trip.legs.some((leg) => leg.fromStationId === stationId || leg.toStationId === stationId);
}

/** Returns the passenger's map position after the supplied number of game minutes. */
export function passengerPositionAt(
  trip: RepresentativePassenger,
  stationCoords: ReadonlyMap<string, PassengerCoordinate>,
  elapsedGameMinutes: number,
): PassengerCoordinate | undefined {
  const endPosition = stationCoords.get(trip.endStationId);
  if (elapsedGameMinutes >= trip.doorToDoorMinutes && endPosition) return { ...endPosition };

  let elapsed = Math.max(0, Number.isFinite(elapsedGameMinutes) ? elapsedGameMinutes : 0);
  let previousPosition: PassengerCoordinate | undefined;
  for (const leg of trip.legs) {
    const duration = Math.max(0, Number.isFinite(leg.minutes) ? leg.minutes : 0);
    const from = leg.fromStationId ? stationCoords.get(leg.fromStationId) : undefined;
    const to = leg.toStationId ? stationCoords.get(leg.toStationId) : undefined;
    let position = from ?? to ?? previousPosition;
    if (leg.kind === 'ride' && from && to) {
      const fraction = duration === 0 ? 1 : Math.min(1, elapsed / duration);
      position = interpolateRide(leg, from, to, fraction, stationCoords);
    }
    if (position) previousPosition = position;
    if (elapsed < duration) {
      return position ? { ...position } : undefined;
    }
    elapsed -= duration;
  }
  return endPosition ? { ...endPosition } : previousPosition ? { ...previousPosition } : undefined;
}

/** Returns the interpolated position of the followed train, or undefined when it is unavailable. */
export function followCameraTarget(
  trainPositions: readonly TrainPosition[],
  state: FollowState,
): Pick<TrainPosition, 'lon' | 'lat'> | undefined {
  if (state.kind !== 'followingTrain') return undefined;
  const train = trainPositions.find(({ id, lineId }) => id === state.trainId && lineId === state.lineId);
  return train ? { lon: train.lon, lat: train.lat } : undefined;
}
