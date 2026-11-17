import { describe, expect, it } from 'vitest';
import {
  formatPanelCount,
  formatPanelDuration,
  formatPanelHeadway,
  formatPanelKm,
  formatPanelPercent,
} from '../../src/ui/panels';

describe('operation panel value formatting', () => {
  it('formats counts, route length, and durations for Traditional Chinese UI', () => {
    expect(formatPanelCount(123456.7)).toBe('123,457');
    expect(formatPanelKm(2.345)).toBe('2.35 公里');
    expect(formatPanelDuration(3660)).toBe('1 小時 1 分');
  });

  it('formats service headway, no-service state, and signed ratios', () => {
    expect(formatPanelHeadway(540)).toBe('9.0 分');
    expect(formatPanelHeadway(720)).toBe('12 分');
    expect(formatPanelHeadway(null)).toBe('無班次');
    expect(formatPanelPercent(-0.125)).toBe('-12%');
    expect(formatPanelPercent(0)).toBe('0%');
    expect(formatPanelPercent(0.0014)).toBe('0.1%');
    expect(formatPanelPercent(-0.034)).toBe('-3.4%');
  });
});
