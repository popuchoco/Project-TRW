import { describe, expect, it } from 'vitest';
import { buildSectionFlowChart, type SectionFlowByPeriod } from '../../src/ui/section-flow-chart';

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
});
