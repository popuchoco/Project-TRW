import { compareText } from '../sim/compare';

export interface StationLabelItem {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  isTransfer: boolean;
  dailyRidership: number;
  name: string;
}

export interface LabelPlacementOptions {
  zoom: number;
  farZoomThreshold: number;
  farTopN: number;
  stationRadius: number;
  gridCell: number;
}

export interface LabelAnchor {
  x: number;
  y: number;
}

export type LabelPlacement =
  | { id: string; x: number; y: number; anchor: LabelAnchor }
  | { id: string; hidden: true };

export interface StationLabelCameraState {
  centerX: number;
  centerY: number;
  scale: number;
  width: number;
  height: number;
}

/** Tracks whether station label inputs changed enough to require a new layout. */
export class StationLabelInvalidator {
  private invalidated = false;
  private totalRecomputeCount = 0;
  private lastCameraState?: StationLabelCameraState;

  get recomputeCount(): number {
    return this.totalRecomputeCount;
  }

  markNetworkChanged(): void {
    this.invalidated = true;
  }

  markCameraChanged(camera: StationLabelCameraState): void {
    const previous = this.lastCameraState;
    this.lastCameraState = camera;
    if (!previous || previous.centerX !== camera.centerX || previous.centerY !== camera.centerY
      || previous.scale !== camera.scale || previous.width !== camera.width || previous.height !== camera.height) {
      this.invalidated = true;
    }
  }

  consume(): boolean {
    if (!this.invalidated) return false;
    this.invalidated = false;
    this.totalRecomputeCount += 1;
    return true;
  }
}

// 可調：低於此相對縮放時，遠景只保留轉乘站與高運量站。
export const STATION_LABEL_FAR_ZOOM_THRESHOLD = 2.2;
// 可調：遠景額外保留的高運量站數量。
export const STATION_LABEL_FAR_TOP_N = 24;
// 可調：站點最外側白圈半徑，確保標籤不壓住站點圓點。
export const STATION_LABEL_STATION_RADIUS = 9;
// 可調：標籤與站點圓點之間的留白。
export const STATION_LABEL_GAP = 3;
// 可調：碰撞格網每格的螢幕像素邊長。
export const STATION_LABEL_GRID_CELL = 64;

const LABEL_CANDIDATE_DIRECTIONS: ReadonlyArray<LabelAnchor> = [
  { x: 0, y: 0.5 },
  { x: 1, y: 0.5 },
  { x: 0.5, y: 1 },
  { x: 0.5, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: 0 },
  { x: 1, y: 1 },
  { x: 1, y: 0 },
];

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface StationDot {
  x: number;
  y: number;
  index: number;
}

interface Candidate {
  x: number;
  y: number;
  anchor: LabelAnchor;
  rect: Rect;
}

type Grid = Map<string, number[]>;

function comparePriority(a: StationLabelItem, b: StationLabelItem): number {
  if (a.isTransfer !== b.isTransfer) return a.isTransfer ? -1 : 1;
  const ridershipA = safeRidership(a.dailyRidership);
  const ridershipB = safeRidership(b.dailyRidership);
  if (ridershipA !== ridershipB) return ridershipA > ridershipB ? -1 : 1;
  return compareText(a.name, b.name) || compareText(a.id, b.id);
}

function compareRidership(a: StationLabelItem, b: StationLabelItem): number {
  const ridershipA = safeRidership(a.dailyRidership);
  const ridershipB = safeRidership(b.dailyRidership);
  if (ridershipA !== ridershipB) return ridershipA > ridershipB ? -1 : 1;
  return compareText(a.name, b.name) || compareText(a.id, b.id);
}

function safeRidership(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function rectFor(x: number, y: number, w: number, h: number, anchor: LabelAnchor): Rect {
  return {
    left: x - w * anchor.x,
    top: y - h * anchor.y,
    right: x + w * (1 - anchor.x),
    bottom: y + h * (1 - anchor.y),
  };
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function rectOverlapsDot(rect: Rect, dot: StationDot, radius: number): boolean {
  const nearestX = Math.max(rect.left, Math.min(dot.x, rect.right));
  const nearestY = Math.max(rect.top, Math.min(dot.y, rect.bottom));
  return (nearestX - dot.x) ** 2 + (nearestY - dot.y) ** 2 < radius ** 2;
}

function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

function forEachCell(rect: Rect, cellSize: number, visit: (key: string) => void): void {
  const minX = Math.floor(rect.left / cellSize);
  const maxX = Math.floor(rect.right / cellSize);
  const minY = Math.floor(rect.top / cellSize);
  const maxY = Math.floor(rect.bottom / cellSize);
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) visit(cellKey(x, y));
  }
}

function addToGrid(grid: Grid, rect: Rect, cellSize: number, index: number): void {
  forEachCell(rect, cellSize, (key) => {
    const bucket = grid.get(key);
    if (bucket) bucket.push(index);
    else grid.set(key, [index]);
  });
}

function nearbyIndices(grid: Grid, rect: Rect, cellSize: number): Set<number> {
  const indices = new Set<number>();
  forEachCell(rect, cellSize, (key) => {
    for (const index of grid.get(key) ?? []) indices.add(index);
  });
  return indices;
}

function candidateFor(
  item: StationLabelItem,
  anchor: LabelAnchor,
  radius: number,
): Candidate {
  const horizontalOffset = anchor.x === 0 ? radius + STATION_LABEL_GAP
    : anchor.x === 1 ? -(radius + STATION_LABEL_GAP)
      : 0;
  const verticalOffset = anchor.y === 0 ? radius + STATION_LABEL_GAP
    : anchor.y === 1 ? -(radius + STATION_LABEL_GAP)
      : 0;
  const x = item.x + horizontalOffset;
  const y = item.y + verticalOffset;
  return { x, y, anchor, rect: rectFor(x, y, item.w, item.h, anchor) };
}

/**
 * Places station labels in stable priority order. All station dots are indexed
 * as obstacles before labels are considered, so labels cannot cover any dot.
 */
export function placeLabels(
  items: readonly StationLabelItem[],
  opts: LabelPlacementOptions,
): LabelPlacement[] {
  if (!Number.isFinite(opts.gridCell) || opts.gridCell <= 0) {
    throw new RangeError('Label collision grid cell must be positive and finite.');
  }
  if (!Number.isFinite(opts.stationRadius) || opts.stationRadius < 0) {
    throw new RangeError('Station radius must be non-negative and finite.');
  }

  const ranked = [...items].sort(comparePriority);
  const includedIds = opts.zoom < opts.farZoomThreshold
    ? new Set([
      ...ranked.filter(({ isTransfer }) => isTransfer).map(({ id }) => id),
      ...[...items].sort(compareRidership).slice(0, Math.max(0, Math.floor(opts.farTopN))).map(({ id }) => id),
    ])
    : undefined;

  const stationDots: StationDot[] = items.map((item, index) => ({ x: item.x, y: item.y, index }));
  const stationGrid: Grid = new Map();
  stationDots.forEach((dot, index) => {
    addToGrid(stationGrid, {
      left: dot.x - opts.stationRadius,
      top: dot.y - opts.stationRadius,
      right: dot.x + opts.stationRadius,
      bottom: dot.y + opts.stationRadius,
    }, opts.gridCell, index);
  });

  const placedRects: Rect[] = [];
  const placedGrid: Grid = new Map();
  const placements = new Map<string, LabelPlacement>();

  for (const item of ranked) {
    if (includedIds && !includedIds.has(item.id)) {
      placements.set(item.id, { id: item.id, hidden: true });
      continue;
    }
    if (![item.x, item.y, item.w, item.h].every(Number.isFinite) || item.w < 0 || item.h < 0) {
      placements.set(item.id, { id: item.id, hidden: true });
      continue;
    }

    let chosen: Candidate | undefined;
    for (const anchor of LABEL_CANDIDATE_DIRECTIONS) {
      const candidate = candidateFor(item, anchor, opts.stationRadius);
      const blockedByDot = [...nearbyIndices(stationGrid, candidate.rect, opts.gridCell)]
        .some((index) => rectOverlapsDot(candidate.rect, stationDots[index]!, opts.stationRadius));
      if (blockedByDot) continue;
      const blockedByLabel = [...nearbyIndices(placedGrid, candidate.rect, opts.gridCell)]
        .some((index) => rectsOverlap(candidate.rect, placedRects[index]!));
      if (blockedByLabel) continue;
      chosen = candidate;
      break;
    }

    if (!chosen) {
      placements.set(item.id, { id: item.id, hidden: true });
      continue;
    }
    const placedIndex = placedRects.push(chosen.rect) - 1;
    addToGrid(placedGrid, chosen.rect, opts.gridCell, placedIndex);
    placements.set(item.id, { id: item.id, x: chosen.x, y: chosen.y, anchor: chosen.anchor });
  }

  return [...placements.values()].sort((a, b) => compareText(a.id, b.id));
}
