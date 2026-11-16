import type { BBox, Position } from './types';

interface Entry<T> {
  value: T;
  bbox: BBox;
}

interface Node<T> {
  bounds: BBox;
  depth: number;
  entries: Entry<T>[];
  children?: Node<T>[];
}

function intersects(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

function contains(outer: BBox, inner: BBox): boolean {
  return inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];
}

function union(entries: Entry<unknown>[]): BBox {
  if (entries.length === 0) return [0, 0, 0, 0];
  return entries.reduce<BBox>(
    (bounds, entry) => [
      Math.min(bounds[0], entry.bbox[0]),
      Math.min(bounds[1], entry.bbox[1]),
      Math.max(bounds[2], entry.bbox[2]),
      Math.max(bounds[3], entry.bbox[3]),
    ],
    [...entries[0]!.bbox],
  );
}

/** A static bbox quadtree supporting point and rectangle queries. */
export class QuadTree<T> {
  private readonly root: Node<T>;

  constructor(
    values: readonly T[],
    bboxOf: (value: T) => BBox,
    private readonly capacity = 8,
    private readonly maxDepth = 10,
  ) {
    if (capacity < 1) throw new Error('Quadtree capacity must be at least 1');
    const entries = values.map((value) => ({ value, bbox: bboxOf(value) }));
    const bounds = union(entries);
    const padding = Math.max(bounds[2] - bounds[0], bounds[3] - bounds[1], 1e-9) * 1e-9;
    bounds[0] -= padding;
    bounds[1] -= padding;
    bounds[2] += padding;
    bounds[3] += padding;
    this.root = { bounds, depth: 0, entries: [] };
    for (const entry of entries) this.insert(this.root, entry);
  }

  /** Query either a [x, y] point or a [minX, minY, maxX, maxY] rectangle. */
  query(point: Position): T[];
  query(rect: BBox): T[];
  query(query: Position | BBox): T[] {
    if (query.length === 2) return this.queryRect([query[0], query[1], query[0], query[1]]);
    return this.queryRect(query);
  }

  queryPoint(x: number, y: number): T[] {
    return this.queryRect([x, y, x, y]);
  }

  queryRect(rect: BBox): T[] {
    const matches: T[] = [];
    this.collect(this.root, rect, matches);
    return matches;
  }

  private insert(node: Node<T>, entry: Entry<T>): void {
    if (node.children) {
      const child = node.children.find((candidate) => contains(candidate.bounds, entry.bbox));
      if (child) {
        this.insert(child, entry);
        return;
      }
    }
    node.entries.push(entry);
    if (!node.children && node.entries.length > this.capacity && node.depth < this.maxDepth) {
      this.split(node);
    }
  }

  private split(node: Node<T>): void {
    const [minX, minY, maxX, maxY] = node.bounds;
    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;
    if (midX === minX || midY === minY) return;
    node.children = [
      { bounds: [minX, minY, midX, midY], depth: node.depth + 1, entries: [] },
      { bounds: [midX, minY, maxX, midY], depth: node.depth + 1, entries: [] },
      { bounds: [minX, midY, midX, maxY], depth: node.depth + 1, entries: [] },
      { bounds: [midX, midY, maxX, maxY], depth: node.depth + 1, entries: [] },
    ];
    const retained: Entry<T>[] = [];
    for (const entry of node.entries) {
      const child = node.children.find((candidate) => contains(candidate.bounds, entry.bbox));
      if (child) this.insert(child, entry);
      else retained.push(entry);
    }
    node.entries = retained;
  }

  private collect(node: Node<T>, rect: BBox, matches: T[]): void {
    if (!intersects(node.bounds, rect)) return;
    for (const entry of node.entries) {
      if (intersects(entry.bbox, rect)) matches.push(entry.value);
    }
    for (const child of node.children ?? []) this.collect(child, rect, matches);
  }
}
