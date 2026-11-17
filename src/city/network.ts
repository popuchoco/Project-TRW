import { SIMULATION_BALANCE, TRANSIT_MODES, type SimulationPeriodId, type TransitModeId } from './modes';

export interface Station {
  id: string;
  name: string;
  lon: number;
  lat: number;
  nameManual?: boolean;
}

export interface Line {
  id: string;
  mode: TransitModeId;
  stationIds: string[];
  peakTrains: number;
  offPeakTrains: number;
  cars: number;
  color: string;
  name: string;
}

export interface Network {
  stations: Station[];
  lines: Line[];
  /** Shared monotonic counter used to create deterministic station and line IDs. */
  nextId: number;
}

export interface LineSpacingWarning {
  lineId: string;
  segmentIndex: number;
  spacingKm: number;
  recommendedKm: readonly [number, number];
}

const EARTH_RADIUS_KM = 6_371.0088;

export function createEmptyNetwork(): Network {
  return { stations: [], lines: [], nextId: 1 };
}

export function addStation(
  network: Network,
  station: Omit<Station, 'id'>,
): { network: Network; station: Station } {
  const created: Station = { ...station, id: `s${network.nextId}` };
  return {
    network: { ...network, stations: [...network.stations, created], nextId: network.nextId + 1 },
    station: created,
  };
}

export function addLine(
  network: Network,
  line: Omit<Line, 'id'>,
): { network: Network; line: Line } {
  const created: Line = { ...line, stationIds: [...line.stationIds], id: `l${network.nextId}` };
  return {
    network: { ...network, lines: [...network.lines, created], nextId: network.nextId + 1 },
    line: created,
  };
}

/** A station is a transfer point when both supported modes serve it. */
export function isTransferStation(network: Network, stationId: string): boolean {
  let hasBrt = false;
  let hasMetro = false;
  for (const line of network.lines) {
    if (!line.stationIds.includes(stationId)) continue;
    if (line.mode === 'brt') hasBrt = true;
    if (line.mode === 'metro') hasMetro = true;
    if (hasBrt && hasMetro) return true;
  }
  return false;
}

/** Great-circle distance in km, used for lines, access walks and village demand. */
export function haversineKm(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const toRadians = Math.PI / 180;
  const lat1Rad = lat1 * toRadians;
  const lat2Rad = lat2 * toRadians;
  const deltaLat = (lat2 - lat1) * toRadians;
  const deltaLon = (lon2 - lon1) * toRadians;
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1Rad) * Math.cos(lat2Rad) * Math.sin(deltaLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

export function lineLengthKm(line: Line, stations: readonly Station[]): number {
  const byId = new Map(stations.map((station) => [station.id, station]));
  let lengthKm = 0;
  for (let index = 1; index < line.stationIds.length; index += 1) {
    const previous = byId.get(line.stationIds[index - 1]!);
    const current = byId.get(line.stationIds[index]!);
    if (!previous || !current) continue;
    lengthKm += haversineKm(previous.lon, previous.lat, current.lon, current.lat);
  }
  return lengthKm;
}

/**
 * Round-trip seconds = 2 × (one-way distance / average speed + dwell at each
 * listed stop). The dwell estimate includes both terminal stops each way.
 */
export function lineRoundTripTimeSeconds(line: Line, stations: readonly Station[]): number {
  const mode = TRANSIT_MODES[line.mode];
  const travelSeconds = lineLengthKm(line, stations) / mode.avgSpeedKmh * 3_600;
  const dwellSeconds = line.stationIds.length * mode.dwellSecondsPerStop;
  return 2 * (travelSeconds + dwellSeconds);
}

export function trainsForPeriod(line: Line, periodId: SimulationPeriodId): number {
  const period = SIMULATION_BALANCE.periods.find(({ id }) => id === periodId);
  if (!period) throw new RangeError(`Unknown simulation period: ${periodId}`);
  return period.usesPeakTrains ? line.peakTrains : line.offPeakTrains;
}

export function lineHeadwaySeconds(
  line: Line,
  stations: readonly Station[],
  periodId: SimulationPeriodId,
): number {
  const trains = trainsForPeriod(line, periodId);
  if (trains <= 0) return Number.POSITIVE_INFINITY;
  return lineRoundTripTimeSeconds(line, stations) / trains;
}

export function lineHourlyCapacity(
  line: Line,
  stations: readonly Station[],
  periodId: SimulationPeriodId,
): number {
  const headwaySeconds = lineHeadwaySeconds(line, stations, periodId);
  if (!Number.isFinite(headwaySeconds) || headwaySeconds <= 0) return 0;
  return (3_600 / headwaySeconds) * line.cars * TRANSIT_MODES[line.mode].capacityPerCar;
}

/** Station spacing outside the mode's recommended range raises warnings only. */
export function lineSpacingWarnings(line: Line, stations: readonly Station[]): LineSpacingWarning[] {
  const mode = TRANSIT_MODES[line.mode];
  const [minimumKm, maximumKm] = mode.recommendedSpacingKm;
  const byId = new Map(stations.map((station) => [station.id, station]));
  const warnings: LineSpacingWarning[] = [];
  for (let segmentIndex = 0; segmentIndex + 1 < line.stationIds.length; segmentIndex += 1) {
    const start = byId.get(line.stationIds[segmentIndex]!);
    const end = byId.get(line.stationIds[segmentIndex + 1]!);
    if (!start || !end) continue;
    const spacingKm = haversineKm(start.lon, start.lat, end.lon, end.lat);
    if (spacingKm < minimumKm || spacingKm > maximumKm) {
      warnings.push({ lineId: line.id, segmentIndex, spacingKm, recommendedKm: [minimumKm, maximumKm] });
    }
  }
  return warnings;
}

