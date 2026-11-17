import { TRANSIT_MODES, type TransitModeId } from './modes';
import type { Line, Network, Station } from './network';

export interface VillageName {
  name: string;
  townName: string;
}

/** Lookup supplied by the map layer; command code does not depend on geometry or the DOM. */
export type VillageAt = (lon: number, lat: number) => VillageName | undefined;

export interface NewStation {
  lon: number;
  lat: number;
  villageAt: VillageAt;
  /** Supplying a name makes it a manual name, which moving the station preserves. */
  name?: string;
}

export type StationInput = { stationId: string } | NewStation;

/**
 * A command's inverse is made from the network immediately before applying it.
 * This captures ordering and nextId as well as the edited records, so every
 * operation can be undone without lossy reconstruction.
 */
export interface NetworkCommand {
  readonly type: string;
  apply(network: Network): Network;
  inverse(networkBefore: Network): NetworkCommand;
}

function cloneNetwork(network: Network): Network {
  return {
    stations: network.stations.map((station) => ({ ...station })),
    lines: network.lines.map((line) => ({ ...line, stationIds: [...line.stationIds] })),
    nextId: network.nextId,
  };
}

function snapshotCommand(snapshot: Network): NetworkCommand {
  const saved = cloneNetwork(snapshot);
  return {
    type: 'restoreNetwork',
    apply: () => cloneNetwork(saved),
    inverse: (networkBefore) => snapshotCommand(networkBefore),
  };
}

function command(type: string, apply: (network: Network) => Network): NetworkCommand {
  return {
    type,
    apply,
    inverse: (networkBefore) => snapshotCommand(networkBefore),
  };
}

/** Combine related edits into one history step while preserving exact inverse state. */
export function combineCommands(commands: readonly NetworkCommand[], type = 'combinedNetworkEdit'): NetworkCommand {
  if (commands.length === 0) throw new RangeError('A combined command needs at least one edit.');
  const edits = [...commands];
  return {
    type,
    apply: (network) => edits.reduce((current, edit) => edit.apply(current), network),
    inverse: (networkBefore) => snapshotCommand(networkBefore),
  };
}

function requireStation(network: Network, stationId: string): Station {
  const station = network.stations.find((candidate) => candidate.id === stationId);
  if (!station) throw new RangeError(`Unknown station: ${stationId}`);
  return station;
}

function requireLine(network: Network, lineId: string): Line {
  const line = network.lines.find((candidate) => candidate.id === lineId);
  if (!line) throw new RangeError(`Unknown line: ${lineId}`);
  return line;
}

function validateCoordinates(lon: number, lat: number): void {
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw new RangeError(`Invalid longitude: ${lon}`);
  }
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new RangeError(`Invalid latitude: ${lat}`);
  }
}

function uniqueName(baseName: string, network: Network, excludedStationId?: string): string {
  const used = new Set(
    network.stations
      .filter((station) => station.id !== excludedStationId)
      .map((station) => station.name),
  );
  if (!used.has(baseName)) return baseName;
  let suffix = 2;
  while (used.has(`${baseName} (${suffix})`)) suffix += 1;
  return `${baseName} (${suffix})`;
}

/** Pick an automatic village name, adding the town name when needed to disambiguate it. */
export function generateStationName(
  network: Network,
  lon: number,
  lat: number,
  villageAt: VillageAt,
  excludedStationId?: string,
): string {
  const village = villageAt(lon, lat);
  const villageName = village
    ? village.name.length > 0 ? `${village.name}站` : `${village.townName}站`
    : '未命名站';
  const usedNames = new Set(
    network.stations
      .filter((station) => station.id !== excludedStationId)
      .map((station) => station.name),
  );
  if (!usedNames.has(villageName)) return villageName;

  if (village && village.name.length > 0) {
    const townQualifiedName = `${village.townName}${villageName}`;
    if (!usedNames.has(townQualifiedName)) return townQualifiedName;
    return uniqueName(townQualifiedName, network, excludedStationId);
  }
  return uniqueName(villageName, network, excludedStationId);
}

function makeStation(network: Network, input: NewStation): Station {
  validateCoordinates(input.lon, input.lat);
  const suppliedName = input.name?.trim();
  const name = suppliedName
    ? uniqueName(suppliedName, network)
    : generateStationName(network, input.lon, input.lat, input.villageAt);
  return {
    id: `s${network.nextId}`,
    name,
    lon: input.lon,
    lat: input.lat,
    ...(!suppliedName ? { nameManual: false } : { nameManual: true }),
  };
}

function cloneStationInput(input: StationInput): StationInput {
  return 'stationId' in input ? { stationId: input.stationId } : { ...input };
}

function insertStationInput(
  network: Network,
  input: StationInput,
): { stations: Station[]; stationId: string; nextId: number } {
  if ('stationId' in input) {
    requireStation(network, input.stationId);
    return { stations: network.stations, stationId: input.stationId, nextId: network.nextId };
  }
  const station = makeStation(network, input);
  return {
    stations: [...network.stations, station],
    stationId: station.id,
    nextId: network.nextId + 1,
  };
}

export function placeStation(input: NewStation): NetworkCommand {
  const stationInput = { ...input };
  return command('placeStation', (network) => {
    const station = makeStation(network, stationInput);
    return {
      ...network,
      stations: [...network.stations, station],
      nextId: network.nextId + 1,
    };
  });
}

export type NewLineOptions = Partial<Pick<Line, 'peakTrains' | 'offPeakTrains' | 'cars' | 'color' | 'name'>>;

function validateTrainCount(count: number, field: string): number {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError(`${field} must be a non-negative integer`);
  }
  return count;
}

function clampCars(mode: TransitModeId, cars: number): number {
  if (!Number.isFinite(cars)) throw new RangeError('Car count must be finite');
  const rounded = Math.round(cars);
  if (mode === 'brt') return TRANSIT_MODES.brt.carsFixed;
  return Math.min(TRANSIT_MODES.metro.carsMax, Math.max(TRANSIT_MODES.metro.carsMin, rounded));
}

export function createLine(
  firstStationId: string,
  secondStationId: string,
  mode: TransitModeId,
  options: NewLineOptions = {},
): NetworkCommand {
  const lineOptions = { ...options };
  return command('createLine', (network) => {
    requireStation(network, firstStationId);
    requireStation(network, secondStationId);
    if (firstStationId === secondStationId) throw new RangeError('A line needs two distinct stations');
    const lineNumber = network.lines.filter((line) => line.mode === mode).length + 1;
    const defaultName = `${TRANSIT_MODES[mode].name} ${lineNumber}`;
    const line: Line = {
      id: `l${network.nextId}`,
      mode,
      stationIds: [firstStationId, secondStationId],
      peakTrains: validateTrainCount(lineOptions.peakTrains ?? 4, 'peakTrains'),
      offPeakTrains: validateTrainCount(lineOptions.offPeakTrains ?? 2, 'offPeakTrains'),
      cars: clampCars(mode, lineOptions.cars ?? (mode === 'brt' ? 1 : TRANSIT_MODES.metro.defaultCars)),
      color: lineOptions.color ?? (mode === 'brt' ? '#e07832' : '#3194d0'),
      name: lineOptions.name?.trim() || defaultName,
    };
    return { ...network, lines: [...network.lines, line], nextId: network.nextId + 1 };
  });
}

export function extendLine(
  lineId: string,
  end: 'start' | 'end',
  stationInput: StationInput,
): NetworkCommand {
  const input = cloneStationInput(stationInput);
  return command('extendLine', (network) => {
    const line = requireLine(network, lineId);
    const { stations, stationId, nextId } = insertStationInput(network, input);
    if (line.stationIds.includes(stationId)) {
      throw new RangeError(`Station ${stationId} is already on line ${lineId}`);
    }
    const stationIds = end === 'start'
      ? [stationId, ...line.stationIds]
      : [...line.stationIds, stationId];
    return {
      ...network,
      stations,
      lines: network.lines.map((candidate) =>
        candidate.id === lineId ? { ...candidate, stationIds } : candidate,
      ),
      nextId,
    };
  });
}

export function insertStation(
  lineId: string,
  segmentIndex: number,
  stationInput: StationInput,
): NetworkCommand {
  const input = cloneStationInput(stationInput);
  return command('insertStation', (network) => {
    const line = requireLine(network, lineId);
    if (!Number.isInteger(segmentIndex) || segmentIndex < 0 || segmentIndex >= line.stationIds.length - 1) {
      throw new RangeError(`Invalid segment index ${segmentIndex} for line ${lineId}`);
    }
    const { stations, stationId, nextId } = insertStationInput(network, input);
    if (line.stationIds.includes(stationId)) {
      throw new RangeError(`Station ${stationId} is already on line ${lineId}`);
    }
    const stationIds = [
      ...line.stationIds.slice(0, segmentIndex + 1),
      stationId,
      ...line.stationIds.slice(segmentIndex + 1),
    ];
    return {
      ...network,
      stations,
      lines: network.lines.map((candidate) =>
        candidate.id === lineId ? { ...candidate, stationIds } : candidate,
      ),
      nextId,
    };
  });
}

export function moveStation(
  stationId: string,
  lon: number,
  lat: number,
  villageAt: VillageAt,
): NetworkCommand {
  return command('moveStation', (network) => {
    validateCoordinates(lon, lat);
    const station = requireStation(network, stationId);
    const moved: Station = {
      ...station,
      lon,
      lat,
      ...(!station.nameManual
        ? { name: generateStationName(network, lon, lat, villageAt, stationId) }
        : {}),
    };
    return {
      ...network,
      stations: network.stations.map((candidate) => candidate.id === stationId ? moved : candidate),
    };
  });
}

export function deleteStation(stationId: string): NetworkCommand {
  return command('deleteStation', (network) => {
    requireStation(network, stationId);
    const lines = network.lines
      .map((line) => ({ ...line, stationIds: line.stationIds.filter((id) => id !== stationId) }))
      .filter((line) => line.stationIds.length >= 2);
    return {
      ...network,
      stations: network.stations.filter((station) => station.id !== stationId),
      lines,
    };
  });
}

export function deleteLine(lineId: string): NetworkCommand {
  return command('deleteLine', (network) => {
    requireLine(network, lineId);
    return { ...network, lines: network.lines.filter((line) => line.id !== lineId) };
  });
}

export function renameStation(stationId: string, name: string): NetworkCommand {
  const renamed = name.trim();
  if (!renamed) throw new RangeError('Station name must not be empty');
  return command('renameStation', (network) => {
    requireStation(network, stationId);
    return {
      ...network,
      stations: network.stations.map((station) =>
        station.id === stationId ? { ...station, name: renamed, nameManual: true } : station,
      ),
    };
  });
}

export function setLineTrains(lineId: string, peakTrains: number, offPeakTrains: number): NetworkCommand {
  const peak = validateTrainCount(peakTrains, 'peakTrains');
  const offPeak = validateTrainCount(offPeakTrains, 'offPeakTrains');
  return command('setLineTrains', (network) => {
    requireLine(network, lineId);
    return {
      ...network,
      lines: network.lines.map((line) =>
        line.id === lineId ? { ...line, peakTrains: peak, offPeakTrains: offPeak } : line,
      ),
    };
  });
}

/** Metro cars clamp to 3–6; BRT always remains at one car. */
export function setLineCars(lineId: string, cars: number): NetworkCommand {
  if (!Number.isFinite(cars)) throw new RangeError('Car count must be finite');
  return command('setLineCars', (network) => {
    const line = requireLine(network, lineId);
    const normalizedCars = clampCars(line.mode, cars);
    return {
      ...network,
      lines: network.lines.map((candidate) =>
        candidate.id === lineId ? { ...candidate, cars: normalizedCars } : candidate,
      ),
    };
  });
}
