import { describe, expect, it } from 'vitest';
import type { RepresentativePassenger } from '../../src/sim/transit/representative';
import { buildPassengerViewModel, createPassengerView } from '../../src/ui/passenger-view';

const trip: RepresentativePassenger = {
  selectedStationId: 's1',
  odKey: 's1>s2',
  flow: 2,
  startStationId: 's1',
  endStationId: 's2',
  pathSignature: 'l1:s1>s2',
  legs: [
    { kind: 'walkIn', minutes: 1.5, toStationId: 's1' },
    { kind: 'ride', minutes: 10, lineId: '紅線', fromStationId: 's1', toStationId: 's2' },
  ],
  doorToDoorMinutes: 11.5,
  alternativeMinutes: 15,
};

interface FakeElement {
  tagName: string;
  className: string;
  textContent: string;
  children: FakeElement[];
  append(...children: FakeElement[]): void;
}

function createFakeDocument(): Pick<Document, 'createElement'> {
  return {
    createElement(tagName: string): FakeElement {
      return {
        tagName,
        className: '',
        textContent: '',
        children: [],
        append(...children) { this.children.push(...children); },
      };
    },
  } as unknown as Pick<Document, 'createElement'>;
}

describe('representative passenger view', () => {
  it('builds leg, total, reason, and label text', () => {
    const model = buildPassengerViewModel(trip, new Map([
      ['s1', '中央站'],
      ['s2', '市政府站'],
    ]));

    expect(model.label).toBe('模擬值／代表旅客');
    expect(model.legs).toEqual([
      '步行至 中央站・1.5 分',
      '紅線：中央站 → 市政府站・10 分',
    ]);
    expect(model.totalText).toBe('門到門時間：11.5 分');
    expect(model.whyText).toContain('此行程 11.5 分；替代方案 15 分');
    expect(model.whyText).toContain('此行程較快 3.5 分');
  });

  it('writes all visible content as text nodes in a small fake DOM', () => {
    const model = buildPassengerViewModel(trip);
    const root = createPassengerView(createFakeDocument(), model) as unknown as FakeElement;
    const list = root.children.find((child) => child.tagName === 'ul');

    expect(root.children[0]?.textContent).toBe('代表旅客行程');
    expect(root.children[1]?.textContent).toBe('模擬值／代表旅客');
    expect(list?.children.map((child) => child.textContent)).toEqual(model.legs);
    expect(root.children[3]?.textContent).toBe(model.totalText);
    expect(root.children[4]?.textContent).toBe(model.whyText);
  });
});
