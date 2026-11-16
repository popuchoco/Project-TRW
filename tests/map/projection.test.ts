import { describe, expect, it } from 'vitest';
import { project, projectBBox, unproject, unprojectBBox } from '../../src/map/projection';

describe('Taiwan map projection', () => {
  it('round-trips longitude and latitude through the y-down plane', () => {
    const position: [number, number] = [121.517, 25.0478];
    const roundTrip = unproject(project(position));
    expect(roundTrip[0]).toBeCloseTo(position[0], 10);
    expect(roundTrip[1]).toBeCloseTo(position[1], 10);
  });

  it('round-trips bboxes and keeps north above south on the plane', () => {
    const bounds: [number, number, number, number] = [119.1, 22.2, 122.3, 25.7];
    const projected = projectBBox(bounds);
    expect(projected[1]).toBeLessThan(projected[3]);
    expect(unprojectBBox(projected)).toEqual(bounds);
  });
});
