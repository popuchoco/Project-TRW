import { SIMULATION_BALANCE, TRANSIT_MODES, type SimulationPeriodId } from '../../city/modes';
import {
  haversineKm,
  lineHeadwaySeconds,
  lineLengthKm,
  lineRoundTripTimeSeconds,
  type Line,
  type Network,
  type Station,
} from '../../city/network';
import type { VillageDemandPoint } from './demand';

export interface WalkAccess {
  stationId: string;
  walkSeconds: number;
}

export interface RideSegment {
  lineId: string;
  segmentIndex: number;
  direction: 1 | -1;
}

export interface RideLeg {
  lineId: string;
  fromStationId: string;
  toStationId: string;
  segments: RideSegment[];
}

export interface TransitPath {
  startStationId: string;
  endStationId: string;
  timeSeconds: number;
  legs: RideLeg[];
  transfers: number;
  /** Stable ID derived from ordered line and station segments. */
  signature: string;
}

export interface LineRuntimeMetrics {
  line: Line;
  lengthKm: number;
  roundTripSeconds: number;
  headwaySeconds: Record<SimulationPeriodId, number>;
}

interface GraphNode {
  lineId: string;
  stationId: string;
  linePosition: number;
}

interface GraphEdge {
  from: number;
  to: number;
  kind: 'ride' | 'transfer';
  baseSeconds: number;
  lineId?: string;
  segmentIndex?: number;
  direction?: 1 | -1;
  stationId?: string;
  targetLineId?: string;
}

interface DijkstraResult {
  distances: Float64Array;
  previousNode: Int32Array;
  previousEdge: Int32Array;
}

interface QueueEntry {
  node: number;
  distance: number;
}

interface PeriodGraph {
  adjacency: number[][];
  searches: Array<DijkstraResult | undefined>;
}

export interface TransitGraphRuntime {
  network: Network;
  stations: Station[];
  lines: Line[];
  stationById: Map<string, Station>;
  lineMetrics: Map<string, LineRuntimeMetrics>;
  nodes: GraphNode[];
  edges: GraphEdge[];
  nodesByStation: Map<string, number[]>;
  periods: Map<SimulationPeriodId, PeriodGraph>;
  pathCache: Map<SimulationPeriodId, Map<string, TransitPath | null>>;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareLines(a: Line, b: Line): number {
  return compareText(a.id, b.id);
}

function validateAndSortNetwork(source: Network): Network {
  if (!Number.isSafeInteger(source.nextId) || source.nextId < 1) {
    throw new RangeError('Network nextId must be a positive safe integer.');
  }
  const stations = source.stations.map((station) => ({ ...station })).sort((a, b) => compareText(a.id, b.id));
  const lines = source.lines.map((line) => ({ ...line, stationIds: [...line.stationIds] })).sort(compareLines);
  const stationById = new Map<string, Station>();
  for (const station of stations) {
    if (!station.id || stationById.has(station.id) || !Number.isFinite(station.lon)
      || !Number.isFinite(station.lat) || station.lat < -90 || station.lat > 90) {
      throw new RangeError(`Invalid or duplicate station: ${station.id}`);
    }
    stationById.set(station.id, station);
  }
  const lineIds = new Set<string>();
  for (const line of lines) {
    if (!line.id || lineIds.has(line.id) || (line.mode !== 'brt' && line.mode !== 'metro')
      || !Number.isSafeInteger(line.peakTrains) || line.peakTrains < 0
      || !Number.isSafeInteger(line.offPeakTrains) || line.offPeakTrains < 0
      || !Number.isSafeInteger(line.cars) || line.cars < 1) {
      throw new RangeError(`Invalid or duplicate line: ${line.id}`);
    }
    if (line.mode === 'brt' && line.cars !== TRANSIT_MODES.brt.carsFixed) {
      throw new RangeError(`BRT line ${line.id} must use ${TRANSIT_MODES.brt.carsFixed} car.`);
    }
    if (line.mode === 'metro' && (line.cars < TRANSIT_MODES.metro.carsMin || line.cars > TRANSIT_MODES.metro.carsMax)) {
      throw new RangeError(`Metro line ${line.id} must use ${TRANSIT_MODES.metro.carsMin}–${TRANSIT_MODES.metro.carsMax} cars.`);
    }
    for (const stationId of line.stationIds) {
      if (!stationById.has(stationId)) throw new RangeError(`Line ${line.id} refers to missing station ${stationId}.`);
    }
    lineIds.add(line.id);
  }
  return { stations, lines, nextId: source.nextId };
}

function addEdge(edges: GraphEdge[], adjacency: number[][], edge: GraphEdge): void {
  const edgeIndex = edges.length;
  edges.push(edge);
  adjacency[edge.from]!.push(edgeIndex);
}

function edgeCompare(a: GraphEdge, b: GraphEdge): number {
  if (a.to !== b.to) return a.to - b.to;
  if (a.kind !== b.kind) return a.kind === 'ride' ? -1 : 1;
  const aLine = a.lineId ?? a.targetLineId ?? '';
  const bLine = b.lineId ?? b.targetLineId ?? '';
  return compareText(aLine, bLine);
}

function queueEntryBefore(a: QueueEntry, b: QueueEntry): boolean {
  return a.distance < b.distance || (a.distance === b.distance && a.node < b.node);
}

function queuePush(queue: QueueEntry[], value: QueueEntry): void {
  let index = queue.length;
  queue.push(value);
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (!queueEntryBefore(value, queue[parent]!)) break;
    queue[index] = queue[parent]!;
    index = parent;
  }
  queue[index] = value;
}

function queuePop(queue: QueueEntry[]): QueueEntry | undefined {
  if (queue.length === 0) return undefined;
  const first = queue[0]!;
  const last = queue.pop()!;
  if (queue.length === 0) return first;
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    const right = left + 1;
    if (left >= queue.length) break;
    const child = right < queue.length && queueEntryBefore(queue[right]!, queue[left]!) ? right : left;
    if (!queueEntryBefore(queue[child]!, last)) break;
    queue[index] = queue[child]!;
    index = child;
  }
  queue[index] = last;
  return first;
}

function makePeriodGraph(
  runtime: Omit<TransitGraphRuntime, 'periods' | 'pathCache'>,
  periodId: SimulationPeriodId,
): PeriodGraph {
  const adjacency = runtime.nodes.map(() => [] as number[]);
  for (let edgeIndex = 0; edgeIndex < runtime.edges.length; edgeIndex += 1) {
    const edge = runtime.edges[edgeIndex]!;
    const metrics = runtime.lineMetrics.get(edge.kind === 'ride' ? edge.lineId! : edge.targetLineId!);
    const headway = metrics?.headwaySeconds[periodId] ?? Number.POSITIVE_INFINITY;
    if (!Number.isFinite(headway)) continue;
    adjacency[edge.from]!.push(edgeIndex);
  }
  for (const edgeIds of adjacency) edgeIds.sort((a, b) => edgeCompare(runtime.edges[a]!, runtime.edges[b]!));

  const searches: Array<DijkstraResult | undefined> = runtime.nodes.map(() => undefined);
  for (let source = 0; source < runtime.nodes.length; source += 1) {
    const node = runtime.nodes[source]!;
    const metrics = runtime.lineMetrics.get(node.lineId);
    const headway = metrics?.headwaySeconds[periodId] ?? Number.POSITIVE_INFINITY;
    if (!Number.isFinite(headway)) continue;

    const distances = new Float64Array(runtime.nodes.length);
    distances.fill(Number.POSITIVE_INFINITY);
    const previousNode = new Int32Array(runtime.nodes.length);
    previousNode.fill(-1);
    const previousEdge = new Int32Array(runtime.nodes.length);
    previousEdge.fill(-1);
    const settled = new Uint8Array(runtime.nodes.length);
    distances[source] = headway / 2;
    const queue: QueueEntry[] = [];
    queuePush(queue, { node: source, distance: distances[source]! });

    // Heap order is distance then stable node index for deterministic ties.
    while (queue.length > 0) {
      const entry = queuePop(queue)!;
      const current = entry.node;
      const bestDistance = entry.distance;
      if (settled[current] !== 0 || bestDistance > distances[current]!) continue;
      settled[current] = 1;
      for (const edgeIndex of adjacency[current]!) {
        const edge = runtime.edges[edgeIndex]!;
        let edgeSeconds = edge.baseSeconds;
        if (edge.kind === 'transfer') {
          const targetMetrics = runtime.lineMetrics.get(edge.targetLineId!);
          const targetHeadway = targetMetrics?.headwaySeconds[periodId] ?? Number.POSITIVE_INFINITY;
          edgeSeconds += SIMULATION_BALANCE.transferPenaltySeconds + targetHeadway / 2;
        }
        const candidate = bestDistance + edgeSeconds;
        const existing = distances[edge.to]!;
        const better = candidate < existing - 1e-9;
        const tiedButEarlier = Math.abs(candidate - existing) <= 1e-9
          && (previousNode[edge.to]! < 0 || current < previousNode[edge.to]!);
        if (better || tiedButEarlier) {
          distances[edge.to] = candidate;
          previousNode[edge.to] = current;
          previousEdge[edge.to] = edgeIndex;
          queuePush(queue, { node: edge.to, distance: candidate });
        }
      }
    }
    searches[source] = { distances, previousNode, previousEdge };
  }
  return { adjacency, searches };
}

export function buildTransitGraph(sourceNetwork: Network): TransitGraphRuntime {
  const network = validateAndSortNetwork(sourceNetwork);
  const stations = network.stations;
  const lines = network.lines;
  const stationById = new Map(stations.map((station) => [station.id, station]));
  const lineMetrics = new Map<string, LineRuntimeMetrics>();
  for (const line of lines) {
    lineMetrics.set(line.id, {
      line,
      lengthKm: lineLengthKm(line, stations),
      roundTripSeconds: lineRoundTripTimeSeconds(line, stations),
      headwaySeconds: {
        morningPeak: lineHeadwaySeconds(line, stations, 'morningPeak'),
        offPeak: lineHeadwaySeconds(line, stations, 'offPeak'),
        eveningPeak: lineHeadwaySeconds(line, stations, 'eveningPeak'),
        night: lineHeadwaySeconds(line, stations, 'night'),
      },
    });
  }

  const nodes: GraphNode[] = [];
  const nodesByStation = new Map<string, number[]>();
  const lineNodes = new Map<string, number[]>();
  for (const line of lines) {
    const currentLineNodes: number[] = [];
    for (let linePosition = 0; linePosition < line.stationIds.length; linePosition += 1) {
      const stationId = line.stationIds[linePosition]!;
      const nodeIndex = nodes.length;
      nodes.push({ lineId: line.id, stationId, linePosition });
      const stationNodes = nodesByStation.get(stationId) ?? [];
      stationNodes.push(nodeIndex);
      nodesByStation.set(stationId, stationNodes);
      currentLineNodes.push(nodeIndex);
    }
    lineNodes.set(line.id, currentLineNodes);
  }

  const edges: GraphEdge[] = [];
  const adjacency = nodes.map(() => [] as number[]);
  for (const line of lines) {
    const mode = TRANSIT_MODES[line.mode];
    const lineNodeIds = lineNodes.get(line.id)!;
    for (let position = 0; position + 1 < lineNodeIds.length; position += 1) {
      const firstNode = lineNodeIds[position]!;
      const secondNode = lineNodeIds[position + 1]!;
      const firstStation = stationById.get(line.stationIds[position]!)!;
      const secondStation = stationById.get(line.stationIds[position + 1]!)!;
      const travelSeconds = haversineKm(firstStation.lon, firstStation.lat, secondStation.lon, secondStation.lat)
        / mode.avgSpeedKmh * 3_600;
      addEdge(edges, adjacency, {
        from: firstNode,
        to: secondNode,
        kind: 'ride',
        baseSeconds: travelSeconds + mode.dwellSecondsPerStop,
        lineId: line.id,
        segmentIndex: position,
        direction: 1,
      });
      addEdge(edges, adjacency, {
        from: secondNode,
        to: firstNode,
        kind: 'ride',
        baseSeconds: travelSeconds + mode.dwellSecondsPerStop,
        lineId: line.id,
        segmentIndex: position,
        direction: -1,
      });
    }
  }

  for (const nodeIds of nodesByStation.values()) {
    for (const from of nodeIds) {
      for (const to of nodeIds) {
        if (from === to || nodes[from]!.lineId === nodes[to]!.lineId) continue;
        addEdge(edges, adjacency, {
          from,
          to,
          kind: 'transfer',
          baseSeconds: 0,
          stationId: nodes[from]!.stationId,
          targetLineId: nodes[to]!.lineId,
        });
      }
    }
  }
  for (const edgeIds of adjacency) edgeIds.sort((a, b) => edgeCompare(edges[a]!, edges[b]!));

  const partial = { network, stations, lines, stationById, lineMetrics, nodes, edges, nodesByStation };
  const periods = new Map<SimulationPeriodId, PeriodGraph>();
  const pathCache = new Map<SimulationPeriodId, Map<string, TransitPath | null>>();
  const periodByServicePattern = new Map<string, SimulationPeriodId>();
  for (const { id } of SIMULATION_BALANCE.periods) {
    const servicePattern = lines
      .map((line) => `${line.id}:${lineMetrics.get(line.id)!.headwaySeconds[id]}`)
      .join('|');
    const previousPeriod = periodByServicePattern.get(servicePattern);
    if (previousPeriod) {
      periods.set(id, periods.get(previousPeriod)!);
      pathCache.set(id, pathCache.get(previousPeriod)!);
    } else {
      periods.set(id, makePeriodGraph(partial, id));
      pathCache.set(id, new Map());
      periodByServicePattern.set(servicePattern, id);
    }
  }
  return { ...partial, periods, pathCache };
}

function makePath(
  runtime: TransitGraphRuntime,
  period: PeriodGraph,
  sourceNode: number,
  destinationNode: number,
  timeSeconds: number,
): TransitPath | null {
  const search = period.searches[sourceNode];
  if (!search) return null;
  const reversedEdgeIds: number[] = [];
  let current = destinationNode;
  while (current !== sourceNode) {
    const edgeIndex = search.previousEdge[current]!;
    const previous = search.previousNode[current]!;
    if (edgeIndex < 0 || previous < 0) return null;
    reversedEdgeIds.push(edgeIndex);
    current = previous;
  }
  reversedEdgeIds.reverse();

  const legs: RideLeg[] = [];
  let currentLeg: RideLeg | undefined;
  for (const edgeIndex of reversedEdgeIds) {
    const edge = runtime.edges[edgeIndex]!;
    if (edge.kind === 'transfer') {
      if (currentLeg) legs.push(currentLeg);
      currentLeg = undefined;
      continue;
    }
    const fromNode = runtime.nodes[edge.from]!;
    const toNode = runtime.nodes[edge.to]!;
    if (!currentLeg) {
      currentLeg = {
        lineId: edge.lineId!,
        fromStationId: fromNode.stationId,
        toStationId: toNode.stationId,
        segments: [],
      };
    }
    currentLeg.toStationId = toNode.stationId;
    currentLeg.segments.push({
      lineId: edge.lineId!,
      segmentIndex: edge.segmentIndex!,
      direction: edge.direction!,
    });
  }
  if (currentLeg) legs.push(currentLeg);
  if (legs.length === 0) return null;

  const startStationId = legs[0]!.fromStationId;
  const endStationId = legs[legs.length - 1]!.toStationId;
  const signature = legs
    .map((leg) => `${leg.lineId}:${leg.fromStationId}>${leg.toStationId}:${leg.segments.map(({ segmentIndex, direction }) => `${segmentIndex}${direction > 0 ? '+' : '-'}`).join(',')}`)
    .join('|');
  return {
    startStationId,
    endStationId,
    timeSeconds,
    legs,
    transfers: Math.max(0, legs.length - 1),
    signature,
  };
}

/** Finds the quickest station-to-station transit path for this time period. */
export function shortestStationPath(
  runtime: TransitGraphRuntime,
  periodId: SimulationPeriodId,
  startStationId: string,
  endStationId: string,
): TransitPath | null {
  const cache = runtime.pathCache.get(periodId)!;
  const cacheKey = `${startStationId}\u0000${endStationId}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey)!;
  const period = runtime.periods.get(periodId)!;
  const starts = runtime.nodesByStation.get(startStationId) ?? [];
  const ends = runtime.nodesByStation.get(endStationId) ?? [];
  let best: { source: number; destination: number; time: number } | undefined;
  for (const source of starts) {
    const search = period.searches[source];
    if (!search) continue;
    for (const destination of ends) {
      const time = search.distances[destination]!;
      if (!Number.isFinite(time)) continue;
      const candidateIsBetter = !best || time < best.time - 1e-9
        || (Math.abs(time - best.time) <= 1e-9
          && (source < best.source || (source === best.source && destination < best.destination)));
      if (candidateIsBetter) best = { source, destination, time };
    }
  }
  const path = best ? makePath(runtime, period, best.source, best.destination, best.time) : null;
  cache.set(cacheKey, path);
  return path;
}

/** Nearest reachable stations are cached once whenever a network is rebuilt. */
export function precomputeVillageAccess(
  villages: readonly VillageDemandPoint[],
  runtime: TransitGraphRuntime,
): WalkAccess[][] {
  return villages.map((village) => runtime.stations
    .filter((station) => (runtime.nodesByStation.get(station.id)?.length ?? 0) > 0)
    .map((station) => ({
      stationId: station.id,
      distanceKm: haversineKm(village.lon, village.lat, station.lon, station.lat),
    }))
    .filter(({ distanceKm }) => distanceKm <= SIMULATION_BALANCE.walkAccessCapKm)
    .sort((a, b) => a.distanceKm - b.distanceKm || compareText(a.stationId, b.stationId))
    .slice(0, SIMULATION_BALANCE.nearestStations)
    .map(({ stationId, distanceKm }) => ({
      stationId,
      walkSeconds: distanceKm * SIMULATION_BALANCE.walkDetourFactor / SIMULATION_BALANCE.walkSpeedKmh * 3_600,
    })));
}

