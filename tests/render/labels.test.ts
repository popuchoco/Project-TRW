import { describe, expect, it } from 'vitest';
import {
  placeLabels,
  StationLabelInvalidator,
  STATION_LABEL_FAR_TOP_N,
  STATION_LABEL_FAR_ZOOM_THRESHOLD,
  STATION_LABEL_GRID_CELL,
  STATION_LABEL_STATION_RADIUS,
  type LabelPlacement,
  type StationLabelItem,
} from '../../src/render/labels';

const options = {
  zoom: 5,
  farZoomThreshold: STATION_LABEL_FAR_ZOOM_THRESHOLD,
  farTopN: STATION_LABEL_FAR_TOP_N,
  stationRadius: STATION_LABEL_STATION_RADIUS,
  gridCell: STATION_LABEL_GRID_CELL,
};

function placedBoxes(items: readonly StationLabelItem[], placements: readonly LabelPlacement[]) {
  const byId = new Map(items.map((item) => [item.id, item]));
  return placements.flatMap((placement) => {
    if ('hidden' in placement) return [];
    const item = byId.get(placement.id)!;
    const { anchor } = placement;
    return [{
      id: placement.id,
      left: placement.x - item.w * anchor.x,
      top: placement.y - item.h * anchor.y,
      right: placement.x + item.w * (1 - anchor.x),
      bottom: placement.y + item.h * (1 - anchor.y),
    }];
  });
}

function expectNoLabelOrStationOverlap(
  items: readonly StationLabelItem[],
  placements: readonly LabelPlacement[],
): void {
  const boxes = placedBoxes(items, placements);
  for (let first = 0; first < boxes.length; first += 1) {
    const box = boxes[first]!;
    for (let second = first + 1; second < boxes.length; second += 1) {
      const other = boxes[second]!;
      expect(
        box.left < other.right && box.right > other.left
          && box.top < other.bottom && box.bottom > other.top,
        `${box.id} overlaps ${other.id}`,
      ).toBe(false);
    }
    for (const station of items) {
      const nearestX = Math.max(box.left, Math.min(station.x, box.right));
      const nearestY = Math.max(box.top, Math.min(station.y, box.bottom));
      expect(
        (nearestX - station.x) ** 2 + (nearestY - station.y) ** 2
          < STATION_LABEL_STATION_RADIUS ** 2,
        `${box.id} overlaps station ${station.id}`,
      ).toBe(false);
    }
  }
}

describe('station label placement', () => {
  it('recomputes only after a camera or network change', () => {
    const invalidator = new StationLabelInvalidator();
    const camera = { centerX: 0, centerY: 0, scale: 1, width: 100, height: 100 };

    expect(invalidator.consume()).toBe(false);
    invalidator.markCameraChanged(camera);
    expect(invalidator.consume()).toBe(true);
    expect(invalidator.consume()).toBe(false);
    invalidator.markCameraChanged({ ...camera });
    expect(invalidator.consume()).toBe(false);
    invalidator.markCameraChanged({ ...camera, centerX: 1 });
    expect(invalidator.consume()).toBe(true);
    invalidator.markNetworkChanged();
    expect(invalidator.consume()).toBe(true);
    expect(invalidator.recomputeCount).toBe(3);
  });

  it('avoids label and station-dot overlaps', () => {
    const items: StationLabelItem[] = Array.from({ length: 30 }, (_, index) => ({
      id: `s${String(index).padStart(2, '0')}`,
      name: `車站${index}`,
      x: (index % 5) * 58,
      y: Math.floor(index / 5) * 34,
      w: 52,
      h: 13,
      isTransfer: index % 7 === 0,
      dailyRidership: 100 - index,
    }));

    expectNoLabelOrStationOverlap(items, placeLabels(items, options));
  });

  it('returns the same placements for repeated and shuffled input', () => {
    const items: StationLabelItem[] = Array.from({ length: 18 }, (_, index) => ({
      id: `s${index}`,
      name: `站${index}`,
      x: (index % 6) * 48,
      y: Math.floor(index / 6) * 42,
      w: 42,
      h: 12,
      isTransfer: index % 5 === 0,
      dailyRidership: (index * 31) % 97,
    }));
    const shuffled = [...items].reverse();

    expect(placeLabels(items, options)).toEqual(placeLabels(items, options));
    expect(placeLabels(items, options)).toEqual(placeLabels(shuffled, options));
  });

  it('keeps the transfer station when labels compete for the same space', () => {
    const items: StationLabelItem[] = [
      {
        id: 'ordinary', name: '一般站', x: 100, y: 100, w: 56, h: 14,
        isTransfer: false, dailyRidership: 1000,
      },
      {
        id: 'transfer', name: '轉乘站', x: 100, y: 100, w: 56, h: 14,
        isTransfer: true, dailyRidership: 1,
      },
    ];
    const placements = placeLabels(items, options);

    const transfer = placements.find(({ id }) => id === 'transfer');
    expect(transfer).toMatchObject({
      id: 'transfer',
      anchor: { x: 0, y: 0.5 },
    });
    expect(placements.find(({ id }) => id === 'ordinary')).toMatchObject({
      id: 'ordinary',
      x: 88,
      y: 100,
      anchor: { x: 1, y: 0.5 },
    });
  });

  it('keeps all transfers and the top N by ridership at far zoom', () => {
    const items: StationLabelItem[] = [
      { id: 'a', name: '甲站', x: 0, y: 0, w: 30, h: 12, isTransfer: false, dailyRidership: 90 },
      { id: 'b', name: '乙站', x: 160, y: 0, w: 30, h: 12, isTransfer: false, dailyRidership: 80 },
      { id: 'c', name: '丙站', x: 320, y: 0, w: 30, h: 12, isTransfer: false, dailyRidership: 70 },
      { id: 'd', name: '丁站', x: 480, y: 0, w: 30, h: 12, isTransfer: false, dailyRidership: 60 },
      { id: 'e', name: '戊站', x: 640, y: 0, w: 30, h: 12, isTransfer: false, dailyRidership: 50 },
      { id: 'transfer', name: '轉乘站', x: 800, y: 0, w: 30, h: 12, isTransfer: true, dailyRidership: 1 },
    ];
    const placements = placeLabels(items, { ...options, zoom: 1, farTopN: 2 });
    const visibleIds = placements.filter((placement) => !('hidden' in placement)).map(({ id }) => id);

    expect(visibleIds).toEqual(['a', 'b', 'transfer']);
  });

  it('places 200 synthetic stations quickly in the box environment', () => {
    const items: StationLabelItem[] = Array.from({ length: 200 }, (_, index) => ({
      id: `s${String(index).padStart(3, '0')}`,
      name: `模擬車站${index}`,
      x: (index % 20) * 120,
      y: Math.floor(index / 20) * 80,
      w: 76,
      h: 14,
      isTransfer: index % 13 === 0,
      dailyRidership: (index * 137) % 10_000,
    }));
    const started = performance.now();
    placeLabels(items, options);
    const elapsedMs = performance.now() - started;

    console.log(`200 station label placement: ${elapsedMs.toFixed(2)} ms (box, Node, not real device)`);
    expect(elapsedMs).toBeLessThan(200);
  });
});
