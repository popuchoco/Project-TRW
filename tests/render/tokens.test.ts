import { describe, expect, it } from 'vitest';
import { DENSITY_PALETTE } from '../../src/map/village-density';
import { LINE_STYLES, STATION_MARKERS } from '../../src/render/tokens';

describe('render design tokens', () => {
  it('keeps transit styles and density classes visually distinct', () => {
    expect(LINE_STYLES.brt.width).toBeLessThan(LINE_STYLES.metro.width);
    expect(DENSITY_PALETTE).toHaveLength(6);
    expect(STATION_MARKERS.transferRingRadius).toBeGreaterThan(STATION_MARKERS.radius);
  });
});
