import { describe, expect, it } from 'vitest';
import {
  buildSectionFlowChart,
  maxSegmentText,
  sectionFlowBarTitle,
  sectionFlowFromSnapshot,
  type SectionFlowByPeriod,
  type SnapshotSectionFlow,
} from '../../src/ui/section-flow-chart';

const flow: SectionFlowByPeriod = {
  morningPeak: [
    { direction: 1, segments: [{ loadFactor: 0.59 }, { loadFactor: 0.6 }, { loadFactor: 0.8 }] },
    { direction: -1, segments: [{ loadFactor: 1.0 }, { loadFactor: 1.01 }, { loadFactor: 0.4 }] },
  ],
  offPeak: [
    { direction: 1, segments: [{ loadFactor: 0.1 }, { loadFactor: 0.2 }, { loadFactor: 0.3 }] },
    { direction: -1, segments: [{ loadFactor: 0.15 }, { loadFactor: 0.25 }, { loadFactor: 0.35 }] },
  ],
  eveningPeak: [
    { direction: 1, segments: [{ loadFactor: 0.4 }, { loadFactor: 0.5 }, { loadFactor: 0.6 }] },
    { direction: -1, segments: [{ loadFactor: 0.3 }, { loadFactor: 0.4 }, { loadFactor: 0.5 }] },
  ],
  night: [
    { direction: 1, segments: [{ loadFactor: 0.05 }, { loadFactor: 0.06 }, { loadFactor: 0.07 }] },
    { direction: -1, segments: [{ loadFactor: 0.04 }, { loadFactor: 0.05 }, { loadFactor: 0.06 }] },
  ],
};

const stationNames = ['臺北車站', '中山', '雙連', '民權西路'];
const size = { width: 320, height: 150 };

describe('buildSectionFlowChart', () => {
  it('builds one bar per direction and segment', () => {
    const chart = buildSectionFlowChart(flow, stationNames, 'morningPeak', size);
    expect(chart.bars).toHaveLength(2 * (stationNames.length - 1));
  });

  it('assigns load bands at the specified boundaries', () => {
    const chart = buildSectionFlowChart(flow, stationNames, 'morningPeak', size);
    expect(chart.bars.map(({ colorBand }) => colorBand)).toEqual([
      'light', 'busy', 'nearCapacity', 'nearCapacity', 'overCapacity', 'light',
    ]);
  });

  it('picks the highest segment, keeping the lower index on ties', () => {
    const tied: SectionFlowByPeriod = {
      ...flow,
      morningPeak: [
        { direction: 1, segments: [{ loadFactor: 0.5 }, { loadFactor: 1.01 }, { loadFactor: 0.2 }] },
        { direction: -1, segments: [{ loadFactor: 1.01 }, { loadFactor: 0.1 }, { loadFactor: 0.2 }] },
      ],
    };
    expect(buildSectionFlowChart(tied, stationNames, 'morningPeak', size).maxSegment).toEqual({
      dir: -1,
      segmentIndex: 0,
      loadFactor: 1.01,
    });
  });

  it('abbreviates each station to its first two characters', () => {
    expect(buildSectionFlowChart(flow, stationNames, 'morningPeak', size).labels).toEqual(['臺北', '中山', '雙連', '民權']);
  });

  it('uses the selected period data', () => {
    const morning = buildSectionFlowChart(flow, stationNames, 'morningPeak', size);
    const offPeak = buildSectionFlowChart(flow, stationNames, 'offPeak', size);
    expect(morning.bars.map(({ colorBand }) => colorBand)).not.toEqual(offPeak.bars.map(({ colorBand }) => colorBand));
    expect(morning.maxSegment?.loadFactor).toBe(1.01);
    expect(offPeak.maxSegment?.loadFactor).toBe(0.35);
  });

  it('formats tooltip titles with station direction, load, capacity, and simulated-value label', () => {
    const withCounts: SectionFlowByPeriod = {
      ...flow,
      morningPeak: [
        { direction: 1, segments: [{ loadFactor: 0.217, load: 1_234, capacity: 5_678 }] },
        { direction: -1, segments: [{ loadFactor: 0.1, load: 100, capacity: 1_000 }] },
      ],
    };
    const model = buildSectionFlowChart(withCounts, stationNames, 'morningPeak', size);
    const forwardBar = model.bars.find(({ dir, segmentIndex }) => dir === 1 && segmentIndex === 0)!;
    expect(sectionFlowBarTitle(forwardBar, stationNames)).toBe(
      '往向 臺北車站→中山：載客 1,234／運能 5,678（21.7%）模擬值',
    );
  });

  it('shows dashes in tooltip titles when load and capacity are missing', () => {
    const model = buildSectionFlowChart(flow, stationNames, 'morningPeak', size);
    const forwardBar = model.bars.find(({ dir, segmentIndex }) => dir === 1 && segmentIndex === 0)!;
    expect(sectionFlowBarTitle(forwardBar, stationNames)).toContain('載客 —／運能 —');
  });

  it('formats the maximum segment in its actual travel direction', () => {
    const forwardDirection = {
      direction: 1 as const,
      segments: [{ loadFactor: 0.9, load: 1_234, capacity: 5_678 }],
    };
    const withCounts: SectionFlowByPeriod = {
      ...flow,
      morningPeak: [
        forwardDirection,
        { direction: -1, segments: [{ loadFactor: 0.95, load: 2_345, capacity: 4_567 }] },
      ],
    };
    const forwardMaximum = buildSectionFlowChart({
      ...withCounts,
      morningPeak: [forwardDirection, { direction: -1, segments: [{ loadFactor: 0.2 }] }],
    }, stationNames, 'morningPeak', size).maxSegment;
    const backwardMaximum = buildSectionFlowChart(withCounts, stationNames, 'morningPeak', size).maxSegment;

    expect(maxSegmentText(forwardMaximum, stationNames)).toBe(
      '最高負載區間：臺北車站→中山（往向）載客 1,234／運能 5,678（90.0%）模擬值',
    );
    expect(maxSegmentText(backwardMaximum, stationNames)).toBe(
      '最高負載區間：中山→臺北車站（返向）載客 2,345／運能 4,567（95.0%）模擬值',
    );
  });
});

describe('sectionFlowFromSnapshot', () => {
  it('maps the sim forward/backward section flow onto chart directions for every period', () => {
    const period = (forward: number[], backward: number[]) => ({
      forward: forward.map((loadFactor) => ({ load: Math.round(loadFactor * 100), capacity: 100, loadFactor })),
      backward: backward.map((loadFactor) => ({ load: Math.round(loadFactor * 100), capacity: 100, loadFactor })),
    });
    const snapshot: SnapshotSectionFlow = {
      morningPeak: period([0.5, 1.1], [0.2, 0.3]),
      offPeak: period([0.1, 0.1], [0.1, 0.1]),
      eveningPeak: period([0.7, 0.9], [0.4, 0.6]),
      night: period([0, 0], [0, 0]),
    };
    const chartInput = sectionFlowFromSnapshot(snapshot);
    expect(chartInput?.morningPeak).toEqual([
      { direction: 1, segments: [{ loadFactor: 0.5, load: 50, capacity: 100 }, { loadFactor: 1.1, load: 110, capacity: 100 }] },
      { direction: -1, segments: [{ loadFactor: 0.2, load: 20, capacity: 100 }, { loadFactor: 0.3, load: 30, capacity: 100 }] },
    ]);
    const model = buildSectionFlowChart(chartInput!, ['甲站', '乙站', '丙站'], 'morningPeak', { width: 200, height: 100 });
    expect(model.maxSegment).toEqual({ dir: 1, segmentIndex: 1, loadFactor: 1.1, load: 110, capacity: 100 });
    expect(sectionFlowFromSnapshot(undefined)).toBeUndefined();
  });
});
