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
import { MapCamera, type ScreenPoint } from './camera';
import { separatePolygonRings } from './polygon-rings';

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

interface VillageRingRef {
  index: number;
  isHole: boolean;
}

interface VillagePolygonRef {
  rings: VillageRingRef[];
  bbox: BBox;
}

interface VillageHitRecord {
  villageIndex: number;
  polygons: VillagePolygonRef[];
  bbox: BBox;
}

const LOD_RANK: Record<LodId, number> = { lod0: 0, lod1: 1, lod2: 2, lod3: 3 };
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

function pointInRing(
  geometry: VillageGeometryData,
  ringIndex: number,
  x: number,
  y: number,
): boolean {
  const start = geometry.ringOffsets[ringIndex]!;
  const end = geometry.ringOffsets[ringIndex + 1]!;
  let inside = false;
  for (let index = start, previous = end - 1; index < end; previous = index, index += 1) {
    const x1 = geometry.coords[previous * 2]!;
    const y1 = geometry.coords[previous * 2 + 1]!;
    const x2 = geometry.coords[index * 2]!;
    const y2 = geometry.coords[index * 2 + 1]!;
    const cross = (x - x1) * (y2 - y1) - (y - y1) * (x2 - x1);
    const dot = (x - x1) * (x - x2) + (y - y1) * (y - y2);
    if (Math.abs(cross) <= 1e-10 && dot <= 1e-10) return true;
    if ((y1 > y) !== (y2 > y) && x < ((x2 - x1) * (y - y1)) / (y2 - y1) + x1) inside = !inside;
  }
  return inside;
}

/** Builds static Pixi display objects; camera changes only transform and cull them. */
export class MapRenderer {
  readonly camera: MapCamera;
  private readonly mapRoot = new Container();
  private readonly villagesRoot = new Container();
  private readonly selectionRoot = new Container();
  private readonly screenRoot = new Container();
  private readonly labelsRoot = new Container();
  private readonly simulationRoot = new Container();
  private readonly insetsRoot = new Container();
  private readonly simulationMarker = new Graphics()
    .circle(0, 0, 7)
    .fill({ color: 0xffffff, alpha: 0.92 })
    .circle(0, 0, 4.5)
    .fill(0x167a9a)
    .circle(0, 0, 4.5)
    .stroke({ color: 0xffffff, width: 1.4 });
  private simulationPosition?: [number, number];
  private readonly layers = new Map<LodId, CountyLayers>();
  private readonly featureSets = new Map<LodId, Map<string, TownFeature[]>>();
  private readonly lod3Features = new Map<string, TownFeature[]>();
  private readonly lod3Indexes = new Map<string, ReturnType<typeof buildTownIndex>>();
  private readonly indexes = new Map<LodId, ReturnType<typeof buildTownIndex>>();
  private readonly labelByCounty = new Map<string, Text>();
  private readonly townBounds: QuadTree<DataManifest['towns'][number]>;
  private readonly insetFeatures: TownFeature[];
  private readonly northNorthBounds: BBox;
  private insetLayouts = new Map<InsetId, InsetLayout>();
  private selectedCode?: string;
  private villageGeometry?: VillageGeometryData;
  private villageDensityBreaks: number[] = [];
  private villageIndex?: QuadTree<VillageHitRecord>;
  private metroViewActive = false;
  private islandViewBeforeMetro?: { x: number; y: number; zoom: number };
  private desiredLod: LodId = 'lod0';
  private visibleCountyCodes: string[] = [];
  private readonly activePointers = new Map<number, PointerPosition>();
  private gestureStart?: ScreenPoint;
  private gestureMoved = false;
  private gestureMultiPointer = false;
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
  ) {
    this.insetFeatures = insetFeatures;
    this.camera = new MapCamera(app.screen.width, app.screen.height, this.mainBounds());
    this.northNorthBounds = this.boundsForNorthNorth();
    this.townBounds = new QuadTree(manifest.towns, (town) => town.bbox);
    this.villagesRoot.visible = false;
    this.app.stage.addChild(this.mapRoot, this.villagesRoot, this.selectionRoot, this.screenRoot);
    this.screenRoot.addChild(this.labelsRoot, this.simulationRoot, this.insetsRoot);
    this.simulationRoot.addChild(this.simulationMarker);
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
    this.camera.panBy(dx, dy);
    this.updateCameraDisplay();
  }

  zoomAt(factor: number, x: number, y: number): void {
    this.camera.zoomAt(factor, x, y);
    this.updateCameraDisplay();
  }

  setCameraView(x: number, y: number, zoom: number): void {
    this.camera.setView(x, y, zoom);
    this.updateCameraDisplay();
  }

  enterMetroView(): void {
    if (this.metroViewActive) return;
    this.islandViewBeforeMetro = {
      x: this.camera.center.x,
      y: this.camera.center.y,
      zoom: this.camera.zoom,
    };
    this.metroViewActive = true;
    this.selectedCode = undefined;
    this.rebuildSelection();
    this.focusNorthNorthBounds();
    this.villagesRoot.visible = Boolean(this.villageGeometry);
    this.onMetroViewChange(true);
  }

  returnToIslandView(): void {
    if (!this.metroViewActive) return;
    this.metroViewActive = false;
    this.villagesRoot.visible = false;
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
    const densities = geometry.villages
      .filter((village) => village.populationMatched)
      .map((village) => village.densityPerKm2!);
    this.villageDensityBreaks = buildDensityBreaks(densities);
    this.buildVillageLayer(geometry);
    this.villagesRoot.visible = this.metroViewActive;
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

  private focusNorthNorthBounds(): void {
    const [minX, minY, maxX, maxY] = projectBBox(this.northNorthBounds);
    const fitScale = Math.min(
      (this.camera.width * 0.92) / (maxX - minX),
      (this.camera.height * 0.88) / (maxY - minY),
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

    const records = polygonGroups.map((group, villageIndex): VillageHitRecord => {
      const polygons = [...group.values()].map((ringIndexes): VillagePolygonRef => {
        const rings = ringIndexes.map((index) => ({ index, isHole: geometry.ringIsHole[index] === 1 }));
        const bbox: BBox = [Infinity, Infinity, -Infinity, -Infinity];
        for (const { index } of rings) {
          const start = geometry.ringOffsets[index]!;
          const end = geometry.ringOffsets[index + 1]!;
          for (let pointIndex = start; pointIndex < end; pointIndex += 1) {
            const x = geometry.coords[pointIndex * 2]!;
            const y = geometry.coords[pointIndex * 2 + 1]!;
            bbox[0] = Math.min(bbox[0], x);
            bbox[1] = Math.min(bbox[1], y);
            bbox[2] = Math.max(bbox[2], x);
            bbox[3] = Math.max(bbox[3], y);
          }
        }
        return { rings, bbox };
      });
      const bbox: BBox = [Infinity, Infinity, -Infinity, -Infinity];
      for (const polygon of polygons) {
        bbox[0] = Math.min(bbox[0], polygon.bbox[0]);
        bbox[1] = Math.min(bbox[1], polygon.bbox[1]);
        bbox[2] = Math.max(bbox[2], polygon.bbox[2]);
        bbox[3] = Math.max(bbox[3], polygon.bbox[3]);
      }
      return { villageIndex, polygons, bbox };
    });
    this.villageIndex = new QuadTree(records, (record) => record.bbox);

    const graphics = new Graphics();
    for (const record of records) {
      const village = geometry.villages[record.villageIndex]!;
      const color = village.populationMatched
        ? DENSITY_PALETTE[densityClassIndex(village.densityPerKm2!, this.villageDensityBreaks)]!
        : UNMATCHED_VILLAGE_COLOR;
      for (const polygon of record.polygons) {
        const outer = polygon.rings.find((ring) => !ring.isHole);
        if (!outer) continue;
        const outerPoints = this.villageRingPoints(geometry, outer.index);
        graphics.poly(outerPoints).fill(color);
        const holes = polygon.rings.filter((ring) => ring.isHole);
        if (holes.length > 0) {
          for (const hole of holes) graphics.poly(this.villageRingPoints(geometry, hole.index));
          graphics.cut();
        }
        graphics.poly(outerPoints).stroke({ color: 0xb7c3bd, width: 0.34, pixelLine: true });
        for (const hole of holes) {
          graphics.poly(this.villageRingPoints(geometry, hole.index)).stroke({ color: 0xb7c3bd, width: 0.34, pixelLine: true });
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
    const geometry = this.villageGeometry;
    const index = this.villageIndex;
    if (!geometry || !index) return undefined;
    for (const record of index.queryPoint(x, y)) {
      const inside = record.polygons.some((polygon) => {
        let polygonContainsPoint = false;
        for (const ring of polygon.rings) {
          if (pointInRing(geometry, ring.index, x, y)) polygonContainsPoint = !polygonContainsPoint;
        }
        return polygonContainsPoint;
      });
      if (inside) return geometry.villages[record.villageIndex];
    }
    return undefined;
  }

  requestRender(): void {
    this.app.renderer.render(this.app.stage);
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

    this.desiredLod = chooseLod(this.camera.zoom);
    this.visibleCountyCodes = this.townBounds
      .queryRect(this.camera.visibleBBox())
      .map(({ countyCode }) => countyCode)
      .filter((code, index, codes) => codes.indexOf(code) === index);
    this.refreshVisibility();
    this.positionCountyLabels();
    this.positionSimulationMarker();
    this.insetsRoot.visible = !this.metroViewActive;
    this.onViewChange(this.desiredLod, this.visibleCountyCodes, this.camera.zoom);
    this.requestRender();
  }

  private positionSimulationMarker(): void {
    if (!this.simulationPosition) return;
    const position = this.camera.lonLatToScreen(this.simulationPosition);
    this.simulationMarker.position.set(position.x, position.y);
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
            fontSize: 12,
            fontWeight: '600',
            fill: 0x48535a,
            stroke: { color: 0xf7f7f3, width: 3 },
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
      this.pinchState = undefined;
    } else {
      this.gestureMoved = true;
      this.gestureMultiPointer = true;
      this.pinchState = this.currentPinchState();
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
      this.updateCameraDisplay();
      return;
    }
    if (this.gestureStart && Math.hypot(point.x - this.gestureStart.x, point.y - this.gestureStart.y) > 4) {
      this.gestureMoved = true;
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
    const hadPointer = this.activePointers.delete(event.pointerId);
    if (!hadPointer) return;
    if (this.activePointers.size === 1) this.pinchState = undefined;
    if (this.activePointers.size === 0) {
      if (!this.gestureMoved && !this.gestureMultiPointer) this.handleTap(point);
      this.gestureStart = undefined;
      this.gestureMoved = false;
      this.gestureMultiPointer = false;
      this.pinchState = undefined;
    }
  };

  private readonly handlePointerCancel = (event: PointerEvent): void => {
    this.activePointers.delete(event.pointerId);
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
      this.focusNorthNorthBounds();
      return;
    }
    this.updateCameraDisplay();
  }
}
