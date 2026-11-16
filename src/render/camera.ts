import { project, projectBBox, unproject, unprojectBBox, type PlanePoint } from '../map/projection';
import type { BBox, Position } from '../map/types';

export interface ScreenPoint {
  x: number;
  y: number;
}

/** Pure camera math shared by gestures, viewport culling and debug controls. */
export class MapCamera {
  width: number;
  height: number;
  scale = 1;
  fitScale = 1;
  center: PlanePoint = { x: 0, y: 0 };
  readonly minZoom = 0.8;
  readonly maxZoom = 30;

  constructor(width: number, height: number, private readonly mapBounds: BBox) {
    this.width = width;
    this.height = height;
    this.fit();
  }

  get zoom(): number {
    return this.scale / this.fitScale;
  }

  fit(): void {
    const [minX, minY, maxX, maxY] = projectBBox(this.mapBounds);
    const mapWidth = maxX - minX;
    const mapHeight = maxY - minY;
    this.fitScale = Math.max(0.0001, Math.min((this.width * 0.94) / mapWidth, (this.height * 0.92) / mapHeight));
    this.scale = this.fitScale;
    this.center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  }

  resize(width: number, height: number): void {
    const zoom = this.zoom;
    this.width = width;
    this.height = height;
    const [minX, minY, maxX, maxY] = projectBBox(this.mapBounds);
    this.fitScale = Math.max(0.0001, Math.min((width * 0.94) / (maxX - minX), (height * 0.92) / (maxY - minY)));
    this.scale = this.fitScale * Math.min(this.maxZoom, Math.max(this.minZoom, zoom));
  }

  panBy(dx: number, dy: number): void {
    this.center.x -= dx / this.scale;
    this.center.y -= dy / this.scale;
  }

  zoomAt(factor: number, screenX: number, screenY: number): void {
    const oldScale = this.scale;
    const nextZoom = Math.min(this.maxZoom, Math.max(this.minZoom, this.zoom * factor));
    this.scale = this.fitScale * nextZoom;
    const worldBefore = this.screenToWorld({ x: screenX, y: screenY }, oldScale);
    this.center.x = worldBefore.x - (screenX - this.width / 2) / this.scale;
    this.center.y = worldBefore.y - (screenY - this.height / 2) / this.scale;
  }

  screenToWorld({ x, y }: ScreenPoint, scale = this.scale): PlanePoint {
    return {
      x: this.center.x + (x - this.width / 2) / scale,
      y: this.center.y + (y - this.height / 2) / scale,
    };
  }

  screenToLonLat(point: ScreenPoint): Position {
    return unproject(this.screenToWorld(point));
  }

  lonLatToScreen(position: Position): ScreenPoint {
    const point = project(position);
    return {
      x: this.width / 2 + (point.x - this.center.x) * this.scale,
      y: this.height / 2 + (point.y - this.center.y) * this.scale,
    };
  }

  visibleBBox(): BBox {
    const topLeft = this.screenToWorld({ x: 0, y: 0 });
    const bottomRight = this.screenToWorld({ x: this.width, y: this.height });
    return unprojectBBox([topLeft.x, topLeft.y, bottomRight.x, bottomRight.y]);
  }

  rootTransform(): { x: number; y: number } {
    return {
      x: this.width / 2 - this.center.x * this.scale,
      y: this.height / 2 - this.center.y * this.scale,
    };
  }
}
