import { describe, expect, it } from 'vitest';
import { createQualityPanel, qualityViewModel } from '../../src/ui/quality-view';
import type { QualityRawStats, QualityScore } from '../../src/sim/transit/quality';

const score: QualityScore = {
  wait: 82,
  transfer: 70,
  crowding: 90,
  denied: 80,
  total: 80.5,
};

const rawStats: QualityRawStats = {
  averageWaitMinutes: 6.2,
  averageTransfers: 0.3,
  averageLoadFactor: 0.85,
  deniedRatio: 0.02,
};

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly style = { width: '' };
  className = '';
  textContent: string | null = '';
  lastElementChild: FakeElement | null = null;

  set innerHTML(_value: string) {
    throw new Error('innerHTML must not be used');
  }

  append(...children: FakeElement[]): void {
    this.children.push(...children);
    this.lastElementChild = children.at(-1) ?? this.lastElementChild;
  }

  replaceChildren(...children: FakeElement[]): void {
    this.children.splice(0, this.children.length, ...children);
    this.lastElementChild = children.at(-1) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

function textOf(element: FakeElement): string {
  return `${element.textContent ?? ''}${element.children.map(textOf).join('')}`;
}

describe('quality view', () => {
  it('builds exact score, bar, and raw detail text', () => {
    expect(qualityViewModel(score, rawStats)).toEqual({
      totalText: '80.5 分',
      badge: '模擬值',
      rows: [
        {
          label: '候車',
          value0to100: 82,
          barPercent: 82,
          valueText: '82 分',
          detailText: '候車：平均 6.2 分鐘',
        },
        {
          label: '轉乘',
          value0to100: 70,
          barPercent: 70,
          valueText: '70 分',
          detailText: '轉乘：每趟 0.3 次',
        },
        {
          label: '擁擠',
          value0to100: 90,
          barPercent: 90,
          valueText: '90 分',
          detailText: '擁擠：平均負載 85%',
        },
        {
          label: '擠不上車',
          value0to100: 80,
          barPercent: 80,
          valueText: '80 分',
          detailText: '擠不上車：2.0%',
        },
      ],
    });
  });

  it('shows an em dash and no bars when the score is null', () => {
    expect(qualityViewModel(null)).toEqual({ totalText: '—', rows: [], badge: '模擬值' });
  });

  it('renders with textContent and marks the values as simulated', () => {
    const fakeDocument = {
      createElement: () => new FakeElement(),
    } as unknown as Document;
    const panel = createQualityPanel(fakeDocument);
    expect(() => panel.update(score, rawStats)).not.toThrow();

    const rendered = panel.element as unknown as FakeElement;
    expect(textOf(rendered)).toContain('模擬值');
    expect(textOf(rendered)).toContain('品質分');
    expect(textOf(rendered)).toContain('候車：平均 6.2 分鐘');
    expect(rendered.children[2]?.children).toHaveLength(4);
  });
});
