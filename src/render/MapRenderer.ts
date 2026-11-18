import { Container, Graphics, Text, type Application } from 'pixi.js';
import { bboxForGeometry } from '../map/geo';
import { buildTownIndex, lookupInset, lookupTownIndexed, type TownFeature } from '../map/hit';
import { chooseLod, type LodId } from '../map/lod';
import { QuadTree } from '../map/quadtree';
import { project, projectBBox, unproject, type PlanePoint } from '../map/projection';
import type { BBox, DataManifest, GeoFeature, TownProperties } from '../map/types';
import {
  buildDensityBreaks,
  DENSITY_PALETTE,
  densityClassIndex,
  UNMATCHED_VILLAGE_COLOR,
} from '../map/village-density';
import type { VillageGeometryData, VillageGeometryRecord } from '../map/village-geometry';
import { VillageGeometryLookup } from '../map/village-lookup';
import { MapCamera, type ScreenPoint } from './camera';
import { separatePolygonRings } from './polygon-rings';
import { isRenderFrameActive } from './RenderScheduler';
import { LABEL_FONT_SIZES, LINE_STYLES, RENDER_PALETTE, STATION_MARKERS } from './tokens';
import { createEmptyNetwork, haversineKm, isTransferStation, type Network } from '../city/network';
import { createStationCoordCache } from './station-coords';
import {
  followCameraTarget,
  passengerPositionAt,
  type FollowState,
  type FollowTrainDisplay,
} from '../city/follow';
import { compareText } from '../sim/compare';
import {
  bboxForTowns,
  chooseInitialMetroBounds,
  TAIPEI_CORE_TOWNCODES,
  villageBoundsFromGeometry,
  type SavedCameraView,
} from '../city/metro-focus';
import type { TrainPosition } from '../sim/protocol';
import {
  placeLabels,
  STATION_LABEL_FAR_TOP_N,
  STATION_LABEL_FAR_ZOOM_THRESHOLD,
  STATION_LABEL_GRID_CELL,
  STATION_LABEL_STATION_RADIUS,
} from './labels';
import type { RepresentativePassenger } from '../sim/transit/representative';

type CountyLayers = Map<string, Container>;
type InsetId = 'diaoyutai' | 'dongsha' | 'nansha';

interface InsetLayout {
  id: InsetId;
  box: { x: number; y: number; width: number; height: number };
  worldCenter: PlanePoint;
  scale: number;
  offset: ScreenPoint;
}

interface PointerPosition extends ScreenPoint {
  pointerId: number;
}

interface PinchState {
  midpoint: ScreenPoint;
  distance: number;
}

interface RouteProgress {
  segmentIndex: number;
  distanceKm: number;
}

interface FollowHandlers {
  start(trainId: string, lineId: string): void;
  drag(): void;
  trainGone(trainId: string): void;
  tripFinished(): void;
}

// 可調：點選列車標記的命中半徑。
const TRAIN_MARKER_HIT_RADIUS_PX = 12;
// 可調：忽略方向估算中的微小位置變化。
const TRAIN_DIRECTION_EPSILON_KM = 0.000001;

function routeProgress(train: TrainPosition, network: Network): RouteProgress | undefined {
  const line = network.lines.find(({ id }) => id === train.lineId);
  if (!line) return undefined;
  const stationsById = new Map(network.stations.map((station) => [station.id, station]));
  const stations = line.stationIds.map((id) => stationsById.get(id)).filter((station) => station !== undefined);
  let cumulativeKm = 0;
  let nearestDistanceSquared = Number.POSITIVE_INFINITY;
  let result: RouteProgress | undefined;
  for (let index = 0; index + 1 < stations.length; index += 1) {
    const start = stations[index]!;
    const end = stations[index + 1]!;
    const latitudeScale = Math.cos(((start.lat + end.lat + train.lat) / 3) * Math.PI / 180);
    const startX = start.lon * latitudeScale;
    const endX = end.lon * latitudeScale;
    const trainX = train.lon * latitudeScale;
    const dx = endX - startX;
    const dy = end.lat - start.lat;
    const lengthSquared = dx * dx + dy * dy;
    const amount = lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((trainX - startX) * dx + (train.lat - start.lat) * dy) / lengthSquared));
    const distanceSquared = (trainX - (startX + amount * dx)) ** 2
      + (train.lat - (start.lat + amount * dy)) ** 2;
    const segmentKm = haversineKm(start.lon, start.lat, end.lon, end.lat);
    if (distanceSquared < nearestDistanceSquared) {
      nearestDistanceSquared = distanceSquared;
      result = { segmentIndex: index, distanceKm: cumulativeKm + amount * segmentKm };
    }
    cumulativeKm += segmentKm;
  }
  return result;
}

export type NetworkEditorHit =
  | { type: 'station'; stationId: string }
  | { type: 'line'; lineId: string; segmentIndex: number }
  | undefined;

export interface NetworkEditorPointer {
  screen: ScreenPoint;
  lonLat: [number, number];
  hit: NetworkEditorHit;
}

export interface NetworkEditorPointerHandler {
  pointerDown(pointer: NetworkEditorPointer): boolean;
  pointerMove(pointer: NetworkEditorPointer): void;
  pointerUp(pointer: NetworkEditorPointer, dragged: boolean): void;
  pointerCancel(): void;
}

export type NetworkSelection = { type: 'station' | 'line'; id: string } | undefined;

const LOD_RANK: Record<LodId, number> = { lod0: 0, lod1: 1, lod2: 2, lod3: 3 };
// 可調：都會視圖取框時保留畫面邊緣空間的比例。
const METRO_FIT_WIDTH_PADDING = 0.92;
const METRO_FIT_HEIGHT_PADDING = 0.88;
const INSET_CAPTIONS: Record<InsetId, string> = {
  diaoyutai: '釣魚臺列嶼（宜蘭縣頭城鎮）',
  dongsha: '東沙（高雄市旗津區）',
  nansha: '南沙太平島（高雄市旗津區）',
};

function townColor(code: string): number {
  let hash = 0;
  for (const character of code) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  const variation = (hash % 11) - 5;
  const channels = [242, 239, 229].map((channel) => Math.max(0, Math.min(255, channel + variation)));
  return (channels[0]! << 16) | (channels[1]! << 8) | channels[2]!;
}

function projectedRing(ring: TownFeature['geometry']['coordinates'][number][number]): number[] {
  const points: number[] = [];
  for (const position of ring) {
    const point = project(position);
    points.push(point.x, point.y);
  }
  return points;
}

function screenRing(
  ring: TownFeature['geometry']['coordinates'][number][number],
  toScreen: (point: PlanePoint) => ScreenPoint,
): number[] {
  const points: number[] = [];
  for (const position of ring) {
    const point = toScreen(project(position));
    points.push(point.x, point.y);
  }
  return points;
}

function colorForFeature(feature: GeoFeature<TownProperties>): number {
  return townColor(feature.properties.TOWNCODE);
}

function colorFromHex(value: string, fallback = 0x3194d0): number {
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) return fallback;
  return Number.parseInt(value.slice(1), 16);
}

function distanceToSegment(point: ScreenPoint, start: ScreenPoint, end: ScreenPoint): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const amount = lengthSquared === 0
    ? 0
    : Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + amount * dx), point.y - (start.y + amount * dy));
}

function drawDashedCasing(
  graphics: Graphics,
  start: PlanePoint,
  end: PlanePoint,
  width: number,
  dashLength: number,
  gapLength: number,
): void {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return;

  const cycleLength = dashLength + gapLength;
  for (let offset = 0; offset < length; offset += cycleLength) {
    const from = offset / length;
    const to = Math.min(offset + dashLength, length) / length;
    graphics
      .moveTo(start.x + dx * from, start.y + dy * from)
      .lineTo(start.x + dx * to, start.y + dy * to)
      .stroke({ color: RENDER_PALETTE.lineCasing, width, pixelLine: true });
  }
}

/** Builds static Pixi display objects; camera changes only transform and cull them. */
export class MapRenderer {
  readonly camera: MapCamera;
  private readonly mapRoot = new Container();
  private readonly villagesRoot = new Container();
  private readonly networkRoot = new Container();
  private readonly networkGraphics = new Graphics();
  private readonly selectionRoot = new Container();
  private readonly screenRoot = new Container();
  private readonly labelsRoot = new Container();
  private readonly stationLabelsRoot = new Container();
  private readonly stationGraphics = new Graphics();
  private readonly trainGraphics = new Graphics();
  private readonly editPreviewGraphics = new Graphics();
  private readonly simulationRoot = new Container();
  private readonly insetsRoot = new Container();
  private readonly simulationMarker = new Graphics()
    .circle(0, 0, 7)
    .fill({ color: 0xffffff, alpha: 0.92 })
    .circle(0, 0, 4.5)
    .fill(0x167a9a)
    .circle(0, 0, 4.5)
    .stroke({ color: 0xffffff, width: 1.4 });
  private readonly passengerMarker = new Graphics()
    .circle(0, 0, 9)
    .fill({ color: 0xffffff, alpha: 0.96 })
    .circle(0, 0, 6)
    .fill(0xd57435)
    .circle(0, 0, 2)
    .fill(0xffffff);
  private simulationPosition?: [number, number];
  private passengerPosition?: [number, number];
  private currentGameTimeMs?: number;
  private readonly layers = new Map<LodId, CountyLayers>();
  private readonly featureSets = new Map<LodId, Map<string, TownFeature[]>>();
  private readonly lod3Features = new Map<string, TownFeature[]>();
  private readonly lod3Indexes = new Map<string, ReturnType<typeof buildTownIndex>>();
  private readonly indexes = new Map<LodId, ReturnType<typeof buildTownIndex>>();
  private readonly labelByCounty = new Map<string, Text>();
  private readonly stationLabelById = new Map<string, Text>();
  private readonly townBounds: QuadTree<DataManifest['towns'][number]>;
  private readonly insetFeatures: TownFeature[];
  private readonly northNorthBounds: BBox;
  private readonly coreTownBounds: BBox;
  private insetLayouts = new Map<InsetId, InsetLayout>();
  private selectedCode?: string;
  private villageGeometry?: VillageGeometryData;
  private villageLookup?: VillageGeometryLookup;
  private villageDensityBreaks: number[] = [];
  private network: Network = createEmptyNetwork();
  private readonly stationCoordCache = createStationCoordCache();
  private stationCoords = this.stationCoordCache.get(this.network);
  private networkPreview?: Network;
  private stationDailyRidership = new Map<string, number>();
  private stationLabelsDirty = true;
  private lastStationLabelsLayout?: {
    network: Network;
    centerX: number;
    centerY: number;
    scale: number;
    width: number;
    height: number;
  };
  private selectedNetworkItem?: NetworkSelection;
  private trainPositions: TrainPosition[] = [];
  private followState: FollowState = { kind: 'idle' };
  private followHandlers?: FollowHandlers;
  private readonly trainDirections = new Map<string, 1 | -1>();
  private editorPointerHandler?: NetworkEditorPointerHandler;
  private editorPointerId?: number;
  private metroViewActive = false;
  private metroInitialFocusPending = false;
  private coreVillageBounds?: BBox;
  private allVillageBounds?: BBox;
  private islandViewBeforeMetro?: { x: number; y: number; zoom: number };
  private desiredLod: LodId = 'lod0';
  private visibleCountyCodes: string[] = [];
  private readonly activePointers = new Map<number, PointerPosition>();
  private gestureStart?: ScreenPoint;
  private gestureMoved = false;
  private gestureMultiPointer = false;
  private followDragNotified = false;
  private pinchState?: PinchState;
  private readonly onResize = (): void => this.handleResize();

  constructor(
    private readonly app: Application,
    private readonly manifest: DataManifest,
    initialFeatures: TownFeature[],
    insetFeatures: TownFeature[],
    private readonly onSelect: (feature: TownFeature) => void,
    private readonly onViewChange: (lod: LodId, visibleCounties: string[], zoom: number) => void,
    private readonly onVillageSelect: (village: VillageGeometryRecord | undefined) => void,
    private readonly onMetroViewChange: (active: boolean) => void,
    private readonly onInvalidate: () => void,
  ) {
    this.insetFeatures = insetFeatures;
    this.camera = new MapCamera(app.screen.width, app.screen.height, this.mainBounds());
    this.northNorthBounds = this.boundsForNorthNorth();
    this.coreTownBounds = this.boundsForTownCodes(TAIPEI_CORE_TOWNCODES) ?? this.northNorthBounds;
    this.townBounds = new QuadTree(manifest.towns, (town) => town.bbox);
    this.villagesRoot.visible = false;
    this.networkRoot.visible = false;
    this.stationGraphics.visible = false;
    this.trainGraphics.visible = false;
    this.stationLabelsRoot.visible = false;
    this.app.stage.addChild(this.mapRoot, this.villagesRoot, this.networkRoot, this.selectionRoot, this.screenRoot);
    this.networkRoot.addChild(this.networkGraphics);
    this.screenRoot.addChild(
      this.labelsRoot,
      this.stationGraphics,
      this.stationLabelsRoot,
      this.trainGraphics,
      this.editPreviewGraphics,
      this.simulationRoot,
      this.insetsRoot,
    );
    this.simulationRoot.addChild(this.simulationMarker, this.passengerMarker);
    this.passengerMarker.visible = false;
    this.setLodFeatures('lod0', initialFeatures);
    this.installPointerHandlers();
    window.addEventListener('resize', this.onResize);
    this.updateCameraDisplay();
  }

  get currentLod(): LodId {
    return this.desiredLod;
  }

  get countiesInView(): string[] {
    return [...this.visibleCountyCodes];
  }

  get zoom(): number {
    return this.camera.zoom;
  }

  get isMetroView(): boolean {
    return this.metroViewActive;
  }

  get hasVisibleTrains(): boolean {
    if (!this.metroViewActive) return false;
    // A followed passenger also needs frames while the simulation is running.
    if (this.followState.kind === 'followingPassenger') return true;
    return this.trainPositions.some((train) => {
      const point = this.camera.lonLatToScreen([train.lon, train.lat]);
      return point.x >= 0 && point.x <= this.camera.width && point.y >= 0 && point.y <= this.camera.height;
    });
  }

  setNetwork(network: Network): void {
    this.network = network;
    this.stationCoords = this.stationCoordCache.get(network);
    this.stationLabelsDirty = true;
    this.trainDirections.clear();
    this.networkPreview = undefined;
    this.drawNetwork();
    this.updateStationNameLabels();
    this.drawTrainMarkers();
    this.requestRender();
  }

  setNetworkPreview(network?: Network): void {
    this.networkPreview = network;
    this.stationLabelsDirty = true;
    this.drawNetwork();
    this.updateStationNameLabels();
    this.requestRender();
  }

  /** Supplies per-station simulated daily entries and exits for label priority. */
  setStationDailyRidership(stats: readonly { stationId: string; dailyRidership: number }[]): void {
    const next = new Map(stats.map(({ stationId, dailyRidership }) => [
      stationId,
      Number.isFinite(dailyRidership) ? Math.max(0, dailyRidership) : 0,
    ]));
    if (next.size === this.stationDailyRidership.size
      && [...next].every(([stationId, ridership]) => this.stationDailyRidership.get(stationId) === ridership)) {
      return;
    }
    this.stationDailyRidership = next;
    this.stationLabelsDirty = true;
    this.updateStationNameLabels();
    this.requestRender();
  }

  setNetworkSelection(selection: NetworkSelection): void {
    this.selectedNetworkItem = selection;
    this.drawNetwork();
    this.requestRender();
  }

  setTrainPositions(trains: readonly TrainPosition[], gameTimeMs?: number): void {
    const frameGameTime = gameTimeMs
      ?? (trains as readonly TrainPosition[] & { readonly gameTimeMs?: number }).gameTimeMs;
    if (frameGameTime !== undefined && Number.isFinite(frameGameTime)) this.currentGameTimeMs = frameGameTime;
    const hadVisibleTrains = this.hasVisibleTrains;
    const followed = this.followState;
    const previousFollowedTrain = followed.kind === 'followingTrain'
      ? this.trainPositions.find(({ id, lineId }) => id === followed.trainId && lineId === followed.lineId)
      : undefined;
    const changed = trains.length !== this.trainPositions.length || trains.some((train, index) => {
      const previous = this.trainPositions[index];
      return !previous || previous.id !== train.id || previous.lineId !== train.lineId
        || previous.lon !== train.lon || previous.lat !== train.lat;
    });

    if (changed) this.trainPositions = trains.map((train) => ({ ...train }));

    if (followed.kind === 'followingTrain') {
      const train = this.trainPositions.find(({ id, lineId }) => id === followed.trainId && lineId === followed.lineId);
      const previousProgress = previousFollowedTrain ? routeProgress(previousFollowedTrain, this.network) : undefined;
      const currentProgress = train ? routeProgress(train, this.network) : undefined;
      const difference = currentProgress && previousProgress
        ? currentProgress.distanceKm - previousProgress.distanceKm
        : 0;
      const direction = Math.abs(difference) > TRAIN_DIRECTION_EPSILON_KM
        ? difference > 0 ? 1 : -1
        : this.trainDirections.get(followed.trainId) ?? 1;
      if (train) this.trainDirections.set(train.id, direction);
    } else {
      this.trainDirections.clear();
    }
    if (followed.kind === 'followingTrain' && !this.trainPositions.some(({ id, lineId }) =>
      id === followed.trainId && lineId === followed.lineId)) {
      this.followHandlers?.trainGone(followed.trainId);
    }

    if (changed && (hadVisibleTrains || this.hasVisibleTrains)) {
      this.drawTrainMarkers();
      this.requestRender();
    }

    const target = followCameraTarget(this.trainPositions, this.followState);
    if (target && this.metroViewActive && isRenderFrameActive()) {
      const center = project([target.lon, target.lat]);
      if (center.x !== this.camera.center.x || center.y !== this.camera.center.y) {
        this.camera.center = center;
        this.updateCameraDisplay();
      }
    }
    if (isRenderFrameActive()) this.updatePassengerFollowFrame();
  }

  setFollowState(state: FollowState): void {
    if (state.kind !== this.followState.kind
      || (state.kind === 'followingTrain' && this.followState.kind === 'followingTrain'
        && (state.trainId !== this.followState.trainId || state.lineId !== this.followState.lineId))) {
      this.trainDirections.clear();
    }
    this.followState = state;
    this.passengerMarker.visible = state.kind === 'followingPassenger' && this.metroViewActive;
  }

  setFollowHandlers(handlers?: FollowHandlers): void {
    this.followHandlers = handlers;
  }

  getTrainOnLine(lineId: string): TrainPosition | undefined {
    return this.trainPositions
      .filter((train) => train.lineId === lineId)
      .sort((a, b) => compareText(a.id, b.id))[0];
  }

  getFollowDisplayInfo(): FollowTrainDisplay | undefined {
    const followState = this.followState;
    if (followState.kind !== 'followingTrain') return undefined;
    const train = this.trainPositions.find(({ id, lineId }) =>
      id === followState.trainId && lineId === followState.lineId);
    const line = this.network.lines.find(({ id }) => id === followState.lineId);
    if (!train || !line) return undefined;
    const stationsById = new Map(this.network.stations.map((station) => [station.id, station]));
    const stations = line.stationIds.map((id) => stationsById.get(id)).filter((station) => station !== undefined);
    const progress = routeProgress(train, this.network);
    if (!progress || stations.length < 2) return undefined;
    const direction = this.trainDirections.get(train.id) ?? 1;
    const nextStation = direction > 0
      ? stations[Math.min(progress.segmentIndex + 1, stations.length - 1)]
      : stations[Math.max(progress.segmentIndex, 0)];
    if (!nextStation) return undefined;
    return {
      lineId: line.id,
      lineName: line.name,
      direction: direction > 0 ? '順向' : '逆向',
      nextStationName: nextStation.name,
    };
  }

  getFollowPassengerTrip(): RepresentativePassenger | undefined {
    return this.followState.kind === 'followingPassenger' ? this.followState.trip : undefined;
  }

  setEditorPointerHandler(handler?: NetworkEditorPointerHandler): void {
    this.editorPointerHandler = handler;
    this.editorPointerId = undefined;
    this.editPreviewGraphics.clear();
    this.requestRender();
  }

  setEditPreviewLine(start?: [number, number], end?: [number, number]): void {
    this.editPreviewGraphics.clear();
    if (start && end) {
      const first = this.camera.lonLatToScreen(start);
      const second = this.camera.lonLatToScreen(end);
      this.editPreviewGraphics
        .moveTo(first.x, first.y)
        .lineTo(second.x, second.y)
        .stroke({ color: 0x153c54, alpha: 0.8, width: 2, pixelLine: true });
    }
    this.requestRender();
  }

  villageNameAt(lon: number, lat: number): { name: string; townName: string } | undefined {
    const village = this.villageLookup?.find(lon, lat);
    return village ? { name: village.name, townName: village.townName } : undefined;
  }

  hitTestNetwork(screen: ScreenPoint): NetworkEditorHit {
    const network = this.networkPreview ?? this.network;
    let nearestStation: { id: string; distance: number } | undefined;
    for (const station of network.stations) {
      const point = this.camera.lonLatToScreen([station.lon, station.lat]);
      const distance = Math.hypot(point.x - screen.x, point.y - screen.y);
      if (distance <= 12 && (!nearestStation || distance < nearestStation.distance)) {
        nearestStation = { id: station.id, distance };
      }
    }
    if (nearestStation) return { type: 'station', stationId: nearestStation.id };

    let nearestLine: { lineId: string; segmentIndex: number; distance: number } | undefined;
    const stationsById = new Map(network.stations.map((station) => [station.id, station]));
    for (const line of network.lines) {
      for (let segmentIndex = 0; segmentIndex + 1 < line.stationIds.length; segmentIndex += 1) {
        const startStation = stationsById.get(line.stationIds[segmentIndex]!);
        const endStation = stationsById.get(line.stationIds[segmentIndex + 1]!);
        if (!startStation || !endStation) continue;
        const start = this.camera.lonLatToScreen([startStation.lon, startStation.lat]);
        const end = this.camera.lonLatToScreen([endStation.lon, endStation.lat]);
        const distance = distanceToSegment(screen, start, end);
        if (distance <= 9 && (!nearestLine || distance < nearestLine.distance)) {
          nearestLine = { lineId: line.id, segmentIndex, distance };
        }
      }
    }
    return nearestLine
      ? { type: 'line', lineId: nearestLine.lineId, segmentIndex: nearestLine.segmentIndex }
      : undefined;
  }

  setLodFeatures(lod: Exclude<LodId, 'lod3'>, features: TownFeature[]): void {
    if (this.layers.has(lod)) return;
    const byCounty = new Map<string, TownFeature[]>();
    for (const feature of features) {
      if (feature.properties.inset) continue;
      const group = byCounty.get(feature.properties.COUNTYCODE) ?? [];
      group.push(feature);
      byCounty.set(feature.properties.COUNTYCODE, group);
    }
    const countyLayers: CountyLayers = new Map();
    for (const [countyCode, countyFeatures] of byCounty) {
      const countyContainer = this.drawTownGroup(countyFeatures);
      countyContainer.visible = false;
      countyLayers.set(countyCode, countyContainer);
      this.mapRoot.addChild(countyContainer);
    }
    this.layers.set(lod, countyLayers);
    this.featureSets.set(lod, byCounty);
    this.indexes.set(lod, buildTownIndex(features));
    this.rebuildSelection();
    this.updateCameraDisplay();
  }

  setLod3County(countyCode: string, features: TownFeature[]): void {
    if (this.lod3Features.has(countyCode)) return;
    const mainFeatures = features.filter(({ properties }) => !properties.inset);
    this.lod3Features.set(countyCode, mainFeatures);
    this.lod3Indexes.set(countyCode, buildTownIndex(mainFeatures));
    const layer = this.drawTownGroup(mainFeatures);
    layer.visible = false;
    this.layers.set('lod3', new Map(this.layers.get('lod3') ?? []).set(countyCode, layer));
    this.mapRoot.addChild(layer);
    this.rebuildSelection();
    this.updateCameraDisplay();
  }

  panBy(dx: number, dy: number): void {
    this.metroInitialFocusPending = false;
    this.camera.panBy(dx, dy);
    this.updateCameraDisplay();
  }

  zoomAt(factor: number, x: number, y: number): void {
    this.metroInitialFocusPending = false;
    this.camera.zoomAt(factor, x, y);
    this.updateCameraDisplay();
  }

  setCameraView(x: number, y: number, zoom: number): void {
    this.camera.setView(x, y, zoom);
    this.updateCameraDisplay();
  }

  enterMetroView(options: { savedCamera?: SavedCameraView } = {}): void {
    if (this.metroViewActive) return;
    this.islandViewBeforeMetro = {
      x: this.camera.center.x,
      y: this.camera.center.y,
      zoom: this.camera.zoom,
    };
    this.metroViewActive = true;
    this.networkRoot.visible = true;
    this.stationGraphics.visible = true;
    this.stationLabelsRoot.visible = true;
    this.trainGraphics.visible = true;
    this.simulationRoot.visible = false;
    this.selectedCode = undefined;
    this.rebuildSelection();
    const initialBounds = chooseInitialMetroBounds({
      savedCamera: options.savedCamera,
      core: this.coreVillageBounds ?? this.coreTownBounds,
      all: this.allVillageBounds ?? this.northNorthBounds,
    });
    this.metroInitialFocusPending = Boolean(initialBounds && !this.villageGeometry);
    if (initialBounds) this.focusBounds(initialBounds);
    this.updateStationNameLabels();
    this.villagesRoot.visible = Boolean(this.villageGeometry);
    this.onMetroViewChange(true);
  }

  showAllNorthNorth(): void {
    this.metroInitialFocusPending = false;
    this.focusBounds(this.allVillageBounds ?? this.northNorthBounds);
  }

  returnToIslandView(): void {
    if (!this.metroViewActive) return;
    this.metroViewActive = false;
    this.villagesRoot.visible = false;
    this.networkRoot.visible = false;
    this.stationGraphics.visible = false;
    this.stationLabelsRoot.visible = false;
    this.trainGraphics.visible = false;
    this.simulationRoot.visible = true;
    const islandView = this.islandViewBeforeMetro;
    this.islandViewBeforeMetro = undefined;
    if (islandView) this.camera.setView(islandView.x, islandView.y, islandView.zoom);
    else this.camera.fit();
    this.onVillageSelect(undefined);
    this.onMetroViewChange(false);
    this.updateCameraDisplay();
  }

  /** Install worker-decoded North–North geometry and return the six-class breaks. */
  setVillageGeometry(geometry: VillageGeometryData): number[] {
    this.villageGeometry = geometry;
    const boundsRecords = villageBoundsFromGeometry(geometry);
    this.coreVillageBounds = bboxForTowns(boundsRecords, TAIPEI_CORE_TOWNCODES);
    this.allVillageBounds = bboxForTowns(boundsRecords, boundsRecords.map(({ TOWNCODE }) => TOWNCODE));
    this.villageLookup = new VillageGeometryLookup(geometry);
    const densities = geometry.villages
      .filter((village) => village.populationMatched)
      .map((village) => village.densityPerKm2!);
    this.villageDensityBreaks = buildDensityBreaks(densities);
    this.buildVillageLayer(geometry);
    this.villagesRoot.visible = this.metroViewActive;
    if (this.metroViewActive && this.metroInitialFocusPending) {
      this.focusBounds(this.coreVillageBounds ?? this.coreTownBounds);
      this.metroInitialFocusPending = false;
    }
    this.requestRender();
    return [...this.villageDensityBreaks];
  }

  setSimulationMarker(lon: number, lat: number): void {
    if (this.simulationPosition?.[0] === lon && this.simulationPosition[1] === lat) return;
    this.simulationPosition = [lon, lat];
    this.positionSimulationMarker();
    this.requestRender();
  }

  hitTown(lon: number, lat: number): TownFeature | undefined {
    for (const countyCode of this.lod3Indexes.keys()) {
      const hit = lookupTownIndexed(this.lod3Indexes.get(countyCode)!, lon, lat);
      if (hit) return hit;
    }
    for (const lod of (['lod2', 'lod1', 'lod0'] as const)) {
      const index = this.indexes.get(lod);
      const hit = index ? lookupTownIndexed(index, lon, lat) : undefined;
      if (hit) return hit;
    }
    return undefined;
  }

  private mainBounds(): BBox {
    const towns = this.manifest.towns;
    return towns.reduce<BBox>(
      (bounds, town) => [
        Math.min(bounds[0], town.bbox[0]),
        Math.min(bounds[1], town.bbox[1]),
        Math.max(bounds[2], town.bbox[2]),
        Math.max(bounds[3], town.bbox[3]),
      ],
      [...towns[0]!.bbox],
    );
  }

  private boundsForNorthNorth(): BBox {
    const towns = this.manifest.towns.filter((town) => town.countyCode === '63000' || town.countyCode === '65000');
    if (towns.length === 0) return this.mainBounds();
    return towns.reduce<BBox>(
      (bounds, town) => [
        Math.min(bounds[0], town.bbox[0]),
        Math.min(bounds[1], town.bbox[1]),
        Math.max(bounds[2], town.bbox[2]),
        Math.max(bounds[3], town.bbox[3]),
      ],
      [...towns[0]!.bbox],
    );
  }

  private boundsForTownCodes(codes: readonly string[]): BBox | undefined {
    return bboxForTowns(
      this.manifest.towns.map((town) => ({ TOWNCODE: town.code, bbox: town.bbox })),
      codes,
    );
  }

  private focusBounds(bounds: BBox): void {
    const [minX, minY, maxX, maxY] = projectBBox(bounds);
    const fitScale = Math.min(
      (this.camera.width * METRO_FIT_WIDTH_PADDING) / (maxX - minX),
      (this.camera.height * METRO_FIT_HEIGHT_PADDING) / (maxY - minY),
    );
    this.camera.setView((minX + maxX) / 2, (minY + maxY) / 2, fitScale / this.camera.fitScale);
    this.updateCameraDisplay();
  }

  private buildVillageLayer(geometry: VillageGeometryData): void {
    this.villagesRoot.removeChildren().forEach((child) => child.destroy());
    const polygonGroups = geometry.villages.map(() => new Map<number, number[]>());
    for (let ringIndex = 0; ringIndex < geometry.ringVillageIndices.length; ringIndex += 1) {
      const villageIndex = geometry.ringVillageIndices[ringIndex]!;
      const polygonIndex = geometry.ringPolygonIndices[ringIndex]!;
      const rings = polygonGroups[villageIndex]?.get(polygonIndex) ?? [];
      rings.push(ringIndex);
      polygonGroups[villageIndex]?.set(polygonIndex, rings);
    }

    const graphics = new Graphics();
    for (let villageIndex = 0; villageIndex < polygonGroups.length; villageIndex += 1) {
      const group = polygonGroups[villageIndex]!;
      const village = geometry.villages[villageIndex]!;
      const color = village.populationMatched
        ? DENSITY_PALETTE[densityClassIndex(village.densityPerKm2!, this.villageDensityBreaks)]!
        : UNMATCHED_VILLAGE_COLOR;
      for (const ringIndexes of group.values()) {
        const outerIndex = ringIndexes.find((ringIndex) => geometry.ringIsHole[ringIndex] === 0);
        if (outerIndex === undefined) continue;
        const outerPoints = this.villageRingPoints(geometry, outerIndex);
        graphics.poly(outerPoints).fill(color);
        const holes = ringIndexes.filter((ringIndex) => geometry.ringIsHole[ringIndex] === 1);
        if (holes.length > 0) {
          for (const holeIndex of holes) graphics.poly(this.villageRingPoints(geometry, holeIndex));
          graphics.cut();
        }
        graphics.poly(outerPoints).stroke({ color: 0xb7c3bd, width: 0.34, pixelLine: true });
        for (const holeIndex of holes) {
          graphics.poly(this.villageRingPoints(geometry, holeIndex)).stroke({ color: 0xb7c3bd, width: 0.34, pixelLine: true });
        }
      }
    }
    this.villagesRoot.addChild(graphics);
  }

  private villageRingPoints(geometry: VillageGeometryData, ringIndex: number): number[] {
    const start = geometry.ringOffsets[ringIndex]! * 2;
    const end = geometry.ringOffsets[ringIndex + 1]! * 2;
    return Array.from(geometry.coords.subarray(start, end));
  }

  private hitVillage(x: number, y: number): VillageGeometryRecord | undefined {
    return this.villageLookup?.findProjected(x, y);
  }

  private drawNetwork(): void {
    this.networkGraphics.clear();
    const network = this.networkPreview ?? this.network;
    const stationsById = new Map(network.stations.map((station) => [station.id, station]));
    for (const line of network.lines) {
      const color = colorFromHex(line.color);
      const selected = this.selectedNetworkItem?.type === 'line' && this.selectedNetworkItem.id === line.id;
      for (let index = 0; index + 1 < line.stationIds.length; index += 1) {
        const first = stationsById.get(line.stationIds[index]!);
        const second = stationsById.get(line.stationIds[index + 1]!);
        if (!first || !second) continue;
        const start = project([first.lon, first.lat]);
        const end = project([second.lon, second.lat]);
        if (line.mode === 'brt') {
          drawDashedCasing(
            this.networkGraphics,
            start,
            end,
            LINE_STYLES.brt.casingWidth,
            LINE_STYLES.brt.casingDashLength,
            LINE_STYLES.brt.casingGapLength,
          );
        } else {
          this.networkGraphics
            .moveTo(start.x, start.y)
            .lineTo(end.x, end.y)
            .stroke({ color: RENDER_PALETTE.lineCasing, width: LINE_STYLES.metro.casingWidth, pixelLine: true });
        }
        this.networkGraphics
          .moveTo(start.x, start.y)
          .lineTo(end.x, end.y)
          .stroke({
            color,
            alpha: selected ? 1 : 0.92,
            width: line.mode === 'brt'
              ? selected ? LINE_STYLES.brt.selectedWidth : LINE_STYLES.brt.width
              : selected ? LINE_STYLES.metro.selectedWidth : LINE_STYLES.metro.width,
            pixelLine: true,
          });
      }
    }
    this.networkRoot.visible = this.metroViewActive;
    this.drawStationMarkers();
  }

  private drawStationMarkers(): void {
    this.stationGraphics.clear();
    const network = this.networkPreview ?? this.network;
    for (const station of network.stations) {
      const point = this.camera.lonLatToScreen([station.lon, station.lat]);
      const selected = this.selectedNetworkItem?.type === 'station' && this.selectedNetworkItem.id === station.id;
      if (isTransferStation(network, station.id)) {
        this.stationGraphics
          .circle(point.x, point.y, STATION_MARKERS.transferRingRadius)
          .stroke({ color: RENDER_PALETTE.transferRing, width: STATION_MARKERS.transferRingWidth, pixelLine: true });
      }
      const markerRadius = selected ? STATION_MARKERS.selectedRadius : STATION_MARKERS.radius;
      const coreRadius = selected ? STATION_MARKERS.selectedCoreRadius : STATION_MARKERS.coreRadius;
      this.stationGraphics
        .circle(point.x, point.y, markerRadius)
        .fill(RENDER_PALETTE.stationOuter)
        .circle(point.x, point.y, coreRadius)
        .fill(selected ? RENDER_PALETTE.stationSelected : RENDER_PALETTE.stationFill);
    }
    this.stationGraphics.visible = this.metroViewActive;
  }

  private drawTrainMarkers(): void {
    this.trainGraphics.clear();
    const linesById = new Map(this.network.lines.map((line) => [line.id, line]));
    for (const train of this.trainPositions) {
      const point = this.camera.lonLatToScreen([train.lon, train.lat]);
      const line = linesById.get(train.lineId);
      const color = line ? colorFromHex(line.color) : 0xd84637;
      this.trainGraphics
        .circle(point.x, point.y, 6)
        .fill({ color: 0xffffff, alpha: 0.96 })
        .circle(point.x, point.y, 3.6)
        .fill(color);
    }
    this.trainGraphics.visible = this.metroViewActive;
  }

  requestRender(): void {
    this.onInvalidate();
  }

  private drawTownGroup(features: TownFeature[]): Container {
    const container = new Container();
    const graphics = new Graphics();
    for (const feature of features) {
      for (const polygon of feature.geometry.coordinates) {
        const { outer, holes } = separatePolygonRings(polygon);
        if (!outer) continue;
        graphics.poly(projectedRing(outer)).fill(colorForFeature(feature));
        // 太麻里鄉有兩個內環；Pixi v8 cut() subtracts them from the fill so the map shows through.
        if (holes.length > 0) {
          for (const hole of holes) graphics.poly(projectedRing(hole));
          graphics.cut();
        }
        graphics.poly(projectedRing(outer)).stroke({ color: 0xb6b9b4, width: 0.8, pixelLine: true });
        for (const hole of holes) {
          graphics.poly(projectedRing(hole)).stroke({ color: 0xb6b9b4, width: 0.8, pixelLine: true });
        }
      }
    }
    container.addChild(graphics);
    return container;
  }

  private updateCameraDisplay(): void {
    const transform = this.camera.rootTransform();
    this.mapRoot.position.set(transform.x, transform.y);
    this.mapRoot.scale.set(this.camera.scale);
    this.villagesRoot.position.set(transform.x, transform.y);
    this.villagesRoot.scale.set(this.camera.scale);
    this.selectionRoot.position.set(transform.x, transform.y);
    this.selectionRoot.scale.set(this.camera.scale);
    this.networkRoot.position.set(transform.x, transform.y);
    this.networkRoot.scale.set(this.camera.scale);

    this.desiredLod = chooseLod(this.camera.zoom);
    this.visibleCountyCodes = this.townBounds
      .queryRect(this.camera.visibleBBox())
      .map(({ countyCode }) => countyCode)
      .filter((code, index, codes) => codes.indexOf(code) === index);
    this.refreshVisibility();
    this.positionCountyLabels();
    this.updateStationNameLabels();
    this.drawStationMarkers();
    this.drawTrainMarkers();
    this.positionSimulationMarker();
    this.positionPassengerMarker();
    this.insetsRoot.visible = !this.metroViewActive;
    this.onViewChange(this.desiredLod, this.visibleCountyCodes, this.camera.zoom);
    this.requestRender();
  }

  private positionSimulationMarker(): void {
    if (!this.simulationPosition) return;
    const position = this.camera.lonLatToScreen(this.simulationPosition);
    this.simulationMarker.position.set(position.x, position.y);
  }

  private positionPassengerMarker(): void {
    const following = this.followState.kind === 'followingPassenger' && this.metroViewActive;
    this.passengerMarker.visible = following && this.passengerPosition !== undefined;
    if (!following || !this.passengerPosition) return;
    const position = this.camera.lonLatToScreen(this.passengerPosition);
    this.passengerMarker.position.set(position.x, position.y);
  }

  private updatePassengerFollowFrame(): void {
    const following = this.followState;
    if (following.kind !== 'followingPassenger' || !this.metroViewActive || this.currentGameTimeMs === undefined) {
      this.passengerMarker.visible = false;
      return;
    }
    const elapsedGameMinutes = (this.currentGameTimeMs - following.startGameTime) / 60_000;
    const position = passengerPositionAt(following.trip, this.stationCoords, elapsedGameMinutes);
    if (position) {
      this.passengerPosition = [position.lon, position.lat];
      this.positionPassengerMarker();
      const center = project([position.lon, position.lat]);
      if (center.x !== this.camera.center.x || center.y !== this.camera.center.y) {
        this.camera.center = center;
        this.updateCameraDisplay();
      }
    }
    if (elapsedGameMinutes >= following.trip.doorToDoorMinutes) this.followHandlers?.tripFinished();
  }

  private refreshVisibility(): void {
    this.mapRoot.alpha = this.metroViewActive ? 0.3 : 1;
    const visible = new Set(this.visibleCountyCodes);
    for (const countyLayers of this.layers.values()) {
      for (const container of countyLayers.values()) container.visible = false;
    }

    const available: Exclude<LodId, 'lod3'>[] = ['lod0', 'lod1', 'lod2'];
    for (const countyCode of this.visibleCountyCodes) {
      let active: Container | undefined;
      if (this.desiredLod === 'lod3') {
        active = this.layers.get('lod3')?.get(countyCode) ?? this.layers.get('lod2')?.get(countyCode);
      }
      if (!active) {
        for (const lod of available) {
          if (LOD_RANK[lod] > LOD_RANK[this.desiredLod]) continue;
          const candidate = this.layers.get(lod)?.get(countyCode);
          if (candidate) active = candidate;
        }
      }
      if (active) active.visible = visible.has(countyCode);
    }
  }

  private positionCountyLabels(): void {
    for (const county of this.manifest.counties) {
      let label = this.labelByCounty.get(county.code);
      if (!label) {
        label = new Text({
          text: county.name,
          style: {
            fontFamily: 'system-ui, sans-serif',
            fontSize: LABEL_FONT_SIZES.county,
            fontWeight: '600',
            fill: RENDER_PALETTE.countyLabel,
            stroke: { color: RENDER_PALETTE.labelHalo, width: LABEL_FONT_SIZES.haloWidth },
          },
        });
        label.anchor.set(0.5);
        this.labelByCounty.set(county.code, label);
        this.labelsRoot.addChild(label);
      }
      const [minLon, minLat, maxLon, maxLat] = county.bbox;
      const position = this.camera.lonLatToScreen([(minLon + maxLon) / 2, (minLat + maxLat) / 2]);
      label.position.set(position.x, position.y);
      label.visible = !this.metroViewActive && position.x >= -40 && position.x <= this.camera.width + 40 &&
        position.y >= -24 && position.y <= this.camera.height + 24;
    }
  }

  private updateStationNameLabels(): void {
    this.stationLabelsRoot.visible = this.metroViewActive;
    if (!this.metroViewActive) return;

    const network = this.networkPreview ?? this.network;
    const previous = this.lastStationLabelsLayout;
    if (!this.stationLabelsDirty && previous?.network === network
      && previous.centerX === this.camera.center.x
      && previous.centerY === this.camera.center.y
      && previous.scale === this.camera.scale
      && previous.width === this.camera.width
      && previous.height === this.camera.height) {
      return;
    }

    const stations = [...network.stations].sort((a, b) => compareText(a.id, b.id));
    const activeIds = new Set(stations.map(({ id }) => id));
    for (const [stationId, label] of this.stationLabelById) {
      if (activeIds.has(stationId)) continue;
      this.stationLabelsRoot.removeChild(label);
      label.destroy();
      this.stationLabelById.delete(stationId);
    }

    const items = stations.map((station) => {
      let label = this.stationLabelById.get(station.id);
      if (!label) {
        label = new Text({
          text: station.name,
          style: {
            fontFamily: 'system-ui, sans-serif',
            fontSize: LABEL_FONT_SIZES.station,
            fontWeight: '600',
            fill: RENDER_PALETTE.stationLabel,
            stroke: { color: RENDER_PALETTE.labelHalo, width: LABEL_FONT_SIZES.haloWidth },
          },
        });
        this.stationLabelById.set(station.id, label);
        this.stationLabelsRoot.addChild(label);
      } else if (label.text !== station.name) {
        label.text = station.name;
      }
      const point = this.camera.lonLatToScreen([station.lon, station.lat]);
      return {
        id: station.id,
        name: station.name,
        x: point.x,
        y: point.y,
        w: label.width,
        h: label.height,
        isTransfer: isTransferStation(network, station.id),
        dailyRidership: this.stationDailyRidership.get(station.id) ?? 0,
      };
    });
    const placements = placeLabels(items, {
      zoom: this.camera.zoom,
      farZoomThreshold: STATION_LABEL_FAR_ZOOM_THRESHOLD,
      farTopN: STATION_LABEL_FAR_TOP_N,
      stationRadius: STATION_LABEL_STATION_RADIUS,
      gridCell: STATION_LABEL_GRID_CELL,
    });

    for (const placement of placements) {
      const label = this.stationLabelById.get(placement.id);
      if (!label) continue;
      if ('hidden' in placement) {
        label.visible = false;
        continue;
      }
      label.anchor.set(placement.anchor.x, placement.anchor.y);
      label.position.set(placement.x, placement.y);
      const left = placement.x - label.width * placement.anchor.x;
      const top = placement.y - label.height * placement.anchor.y;
      label.visible = left <= this.camera.width && left + label.width >= 0
        && top <= this.camera.height && top + label.height >= 0;
    }

    this.lastStationLabelsLayout = {
      network,
      centerX: this.camera.center.x,
      centerY: this.camera.center.y,
      scale: this.camera.scale,
      width: this.camera.width,
      height: this.camera.height,
    };
    this.stationLabelsDirty = false;
  }

  private rebuildSelection(): void {
    this.selectionRoot.removeChildren().forEach((child) => child.destroy());
    // Insets must be (re)built even with no selection, otherwise they only
    // appear after the first click or window resize.
    this.rebuildInsets();
    if (!this.selectedCode) return;
    const feature = this.featureByCode(this.selectedCode);
    if (!feature) return;
    const graphics = new Graphics();
    for (const polygon of feature.geometry.coordinates) {
      for (const ring of polygon) {
        graphics.poly(projectedRing(ring)).stroke({ color: 0x176d8a, width: 2.2, pixelLine: true });
      }
    }
    this.selectionRoot.addChild(graphics);
  }

  private featureByCode(code: string): TownFeature | undefined {
    for (const countyFeatures of this.lod3Features.values()) {
      const found = countyFeatures.find(({ properties }) => properties.TOWNCODE === code);
      if (found) return found;
    }
    for (const lod of (['lod2', 'lod1', 'lod0'] as const)) {
      for (const countyFeatures of this.featureSets.get(lod)?.values() ?? []) {
        const found = countyFeatures.find(({ properties }) => properties.TOWNCODE === code);
        if (found) return found;
      }
    }
    return undefined;
  }

  private rebuildInsets(): void {
    this.insetsRoot.removeChildren().forEach((child) => child.destroy());
    this.insetLayouts.clear();
    if (this.insetFeatures.length === 0) return;

    const width = this.camera.width;
    const height = this.camera.height;
    const margin = 12;
    const cellWidth = Math.min(210, Math.max(128, width * 0.31));
    const cellHeight = Math.min(126, Math.max(88, height * 0.19));
    // Keep the top-right inset clear of the DOM toolbar, which wraps on narrow screens.
    const diaoyutaiX = width - cellWidth - margin;
    const toolbarRect = document.querySelector('.map-toolbar')?.getBoundingClientRect();
    const canvasTop = this.app.canvas.getBoundingClientRect().top;
    const diaoyutaiY = toolbarRect && toolbarRect.right > diaoyutaiX
      ? Math.max(margin, toolbarRect.bottom - canvasTop + 8)
      : margin;
    const boxes: Array<{ id: InsetId; x: number; y: number; width: number; height: number }> = [
      { id: 'diaoyutai', x: diaoyutaiX, y: diaoyutaiY, width: cellWidth, height: cellHeight },
      { id: 'dongsha', x: margin, y: height - cellHeight * 2 - margin * 2, width: cellWidth, height: cellHeight },
      { id: 'nansha', x: margin, y: height - cellHeight - margin, width: cellWidth, height: cellHeight },
    ];
    for (const box of boxes) {
      const feature = this.insetFeatures.find(({ properties }) => properties.inset === box.id);
      if (!feature) continue;
      const bbox = projectBBox(bboxForGeometry(feature.geometry));
      const inset = 7;
      const captionHeight = 20;
      const content = {
        x: box.x + inset,
        y: box.y + captionHeight + inset,
        width: box.width - inset * 2,
        height: box.height - captionHeight - inset * 2,
      };
      const geometryWidth = Math.max(1e-9, bbox[2] - bbox[0]);
      const geometryHeight = Math.max(1e-9, bbox[3] - bbox[1]);
      const scale = Math.min(content.width / geometryWidth, content.height / geometryHeight);
      const worldCenter = { x: (bbox[0] + bbox[2]) / 2, y: (bbox[1] + bbox[3]) / 2 };
      const offset = { x: content.x + content.width / 2, y: content.y + content.height / 2 };
      const toScreen = (point: PlanePoint): ScreenPoint => ({
        x: offset.x + (point.x - worldCenter.x) * scale,
        y: offset.y + (point.y - worldCenter.y) * scale,
      });
      const frame = new Graphics()
        .roundRect(box.x, box.y, box.width, box.height, 6)
        .fill({ color: 0xffffff, alpha: 0.94 })
        .stroke({ color: 0x89959a, width: 1.2, pixelLine: true });
      this.insetsRoot.addChild(frame);
      const insetGraphic = new Graphics();
      for (const polygon of feature.geometry.coordinates) {
        const outer = polygon[0];
        if (!outer || outer.length < 3) continue;
        insetGraphic.poly(screenRing(outer, toScreen)).fill(colorForFeature(feature));
        insetGraphic.poly(screenRing(outer, toScreen)).stroke({ color: 0x747e82, width: 0.9, pixelLine: true });
      }
      if (feature.properties.TOWNCODE === this.selectedCode) {
        for (const polygon of feature.geometry.coordinates) {
          for (const ring of polygon) {
            insetGraphic.poly(screenRing(ring, toScreen)).stroke({ color: 0x176d8a, width: 2, pixelLine: true });
          }
        }
      }
      this.insetsRoot.addChild(insetGraphic);
      const captionText = INSET_CAPTIONS[box.id];
      const caption = new Text({
        text: captionText,
        style: {
          fontFamily: 'system-ui, sans-serif',
          fontSize: Math.min(10, (box.width - 12) / [...captionText].length),
          fill: 0x344147,
        },
      });
      caption.position.set(box.x + 6, box.y + 5);
      this.insetsRoot.addChild(caption);
      this.insetLayouts.set(box.id, { id: box.id, box, worldCenter, scale, offset });
    }
  }

  private installPointerHandlers(): void {
    const canvas = this.app.canvas;
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', this.handlePointerDown);
    canvas.addEventListener('pointermove', this.handlePointerMove);
    canvas.addEventListener('pointerup', this.handlePointerUp);
    canvas.addEventListener('pointercancel', this.handlePointerCancel);
    canvas.addEventListener('wheel', this.handleWheel, { passive: false });
  }

  private toScreen(event: PointerEvent | WheelEvent): ScreenPoint {
    const rect = this.app.canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (this.app.screen.width / rect.width),
      y: (event.clientY - rect.top) * (this.app.screen.height / rect.height),
    };
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    const point = this.toScreen(event);
    this.activePointers.set(event.pointerId, { ...point, pointerId: event.pointerId });
    try { this.app.canvas.setPointerCapture(event.pointerId); } catch { /* capture is optional */ }
    if (this.activePointers.size === 1) {
      this.gestureStart = point;
      this.gestureMoved = false;
      this.gestureMultiPointer = false;
      this.followDragNotified = false;
      this.pinchState = undefined;
      if (this.metroViewActive && this.editorPointerHandler?.pointerDown(this.editorPointer(point))) {
        this.editorPointerId = event.pointerId;
      }
    } else {
      if (this.editorPointerId !== undefined) {
        this.editorPointerHandler?.pointerCancel();
        this.editorPointerId = undefined;
      }
      this.gestureMoved = true;
      this.gestureMultiPointer = true;
      this.pinchState = this.currentPinchState();
      this.notifyFollowDrag();
    }
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    const previous = this.activePointers.get(event.pointerId);
    if (!previous) return;
    const point = this.toScreen(event);
    this.activePointers.set(event.pointerId, { ...point, pointerId: event.pointerId });
    if (this.activePointers.size >= 2) {
      const nextPinch = this.currentPinchState();
      if (this.pinchState && nextPinch) {
        const factor = nextPinch.distance / Math.max(1, this.pinchState.distance);
        this.camera.zoomAt(factor, this.pinchState.midpoint.x, this.pinchState.midpoint.y);
        this.camera.panBy(nextPinch.midpoint.x - this.pinchState.midpoint.x, nextPinch.midpoint.y - this.pinchState.midpoint.y);
      }
      this.pinchState = nextPinch;
      this.gestureMoved = true;
      this.notifyFollowDrag();
      this.updateCameraDisplay();
      return;
    }
    if (this.gestureStart && Math.hypot(point.x - this.gestureStart.x, point.y - this.gestureStart.y) > 4) {
      this.gestureMoved = true;
      this.notifyFollowDrag();
    }
    if (this.editorPointerId === event.pointerId) {
      this.editorPointerHandler?.pointerMove(this.editorPointer(point));
      return;
    }
    const dx = point.x - previous.x;
    const dy = point.y - previous.y;
    if (dx !== 0 || dy !== 0) {
      this.camera.panBy(dx, dy);
      this.updateCameraDisplay();
    }
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    const point = this.toScreen(event);
    const wasEditorPointer = this.editorPointerId === event.pointerId;
    const dragged = this.gestureMoved;
    const hadPointer = this.activePointers.delete(event.pointerId);
    if (!hadPointer) return;
    if (wasEditorPointer) {
      this.editorPointerHandler?.pointerUp(this.editorPointer(point), dragged);
      this.editorPointerId = undefined;
    }
    if (this.activePointers.size === 1) this.pinchState = undefined;
    if (this.activePointers.size === 0) {
      if (!wasEditorPointer && !this.gestureMoved && !this.gestureMultiPointer) this.handleTap(point);
      this.gestureStart = undefined;
      this.gestureMoved = false;
      this.gestureMultiPointer = false;
      this.pinchState = undefined;
    }
  };

  private readonly handlePointerCancel = (event: PointerEvent): void => {
    this.activePointers.delete(event.pointerId);
    if (this.editorPointerId === event.pointerId) {
      this.editorPointerHandler?.pointerCancel();
      this.editorPointerId = undefined;
    }
    this.gestureMoved = true;
    if (this.activePointers.size === 0) this.gestureStart = undefined;
  };

  private readonly handleWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const point = this.toScreen(event);
    this.camera.zoomAt(Math.exp(-event.deltaY * 0.0012), point.x, point.y);
    this.updateCameraDisplay();
  };

  private currentPinchState(): PinchState | undefined {
    const pointers = [...this.activePointers.values()];
    if (pointers.length < 2) return undefined;
    const first = pointers[0]!;
    const second = pointers[1]!;
    return {
      midpoint: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
      distance: Math.hypot(second.x - first.x, second.y - first.y),
    };
  }

  private editorPointer(screen: ScreenPoint): NetworkEditorPointer {
    return {
      screen,
      lonLat: this.camera.screenToLonLat(screen),
      hit: this.hitTestNetwork(screen),
    };
  }

  private handleTap(point: ScreenPoint): void {
    if (!this.metroViewActive) {
      for (const layout of this.insetLayouts.values()) {
        const { box } = layout;
        if (point.x < box.x || point.x > box.x + box.width || point.y < box.y || point.y > box.y + box.height) continue;
        const plane = {
          x: layout.worldCenter.x + (point.x - layout.offset.x) / layout.scale,
          y: layout.worldCenter.y + (point.y - layout.offset.y) / layout.scale,
        };
        const [lon, lat] = unproject(plane);
        const insetFeature = lookupInset(this.insetFeatures, layout.id, lon, lat);
        if (insetFeature) this.select(insetFeature);
        return;
      }
    }
    if (this.metroViewActive) {
      const train = this.hitTestTrain(point);
      if (train) {
        this.followHandlers?.start(train.id, train.lineId);
        return;
      }
      const worldPoint = this.camera.screenToWorld(point);
      this.onVillageSelect(this.hitVillage(worldPoint.x, worldPoint.y));
      return;
    }
    const [lon, lat] = this.camera.screenToLonLat(point);
    const feature = this.hitTown(lon, lat);
    if (feature && (feature.properties.COUNTYCODE === '63000' || feature.properties.COUNTYCODE === '65000')) {
      this.enterMetroView();
    } else if (feature) {
      this.select(feature);
    }
  }

  private hitTestTrain(screen: ScreenPoint): TrainPosition | undefined {
    let nearest: { train: TrainPosition; distance: number } | undefined;
    for (const train of this.trainPositions) {
      const point = this.camera.lonLatToScreen([train.lon, train.lat]);
      const distance = Math.hypot(point.x - screen.x, point.y - screen.y);
      if (distance <= TRAIN_MARKER_HIT_RADIUS_PX && (!nearest || distance < nearest.distance
        || (distance === nearest.distance && compareText(train.id, nearest.train.id) < 0))) {
        nearest = { train, distance };
      }
    }
    return nearest?.train;
  }

  private notifyFollowDrag(): void {
    if (this.followDragNotified) return;
    this.followDragNotified = true;
    this.followHandlers?.drag();
  }

  private select(feature: TownFeature): void {
    this.selectedCode = feature.properties.TOWNCODE;
    this.rebuildSelection();
    this.onSelect(feature);
    this.requestRender();
  }

  private handleResize(): void {
    this.camera.resize(this.app.screen.width, this.app.screen.height);
    this.rebuildInsets();
    if (this.metroViewActive) {
      this.focusBounds(this.allVillageBounds ?? this.northNorthBounds);
      return;
    }
    this.updateCameraDisplay();
  }
}
