import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
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
    { kind: 'wait', minutes: 2, lineId: 'l1', fromStationId: 's1', toStationId: 's1' },
    { kind: 'ride', minutes: 10, lineId: 'l1', fromStationId: 's1', toStationId: 's2' },
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
    ]), new Map([['l1', '紅線']]));

    expect(model.label).toBe('模擬值／代表旅客');
    expect(model.legs).toEqual([
      '步行至 中央站・1.5 分',
      '等候 紅線（中央站）・2 分',
      '紅線：中央站 → 市政府站・10 分',
    ]);
    expect(model.totalText).toBe('門到門時間：11.5 分');
    expect(model.whyText).toBe('為什麼選這條：此行程 11.5 分，比替代方案快 3.5 分；模擬依一般化成本做機率選擇。');
  });

  it('explains when the alternative is faster without calling the chosen trip fastest', () => {
    const model = buildPassengerViewModel({ ...trip, doorToDoorMinutes: 15, alternativeMinutes: 11.5 });

    expect(model.whyText).toBe('為什麼選這條：替代方案快 3.5 分；模擬依一般化成本做機率選擇，這位旅客仍選了此行程。');
    expect(model.whyText).not.toContain('最快');
  });

  it('explains when there is no alternative', () => {
    const model = buildPassengerViewModel({ ...trip, alternativeMinutes: null });

    expect(model.whyText).toBe('為什麼選這條：沒有可比較的替代方案；此行程需 11.5 分。');
  });

  it('falls back to a line id when the line name is unknown', () => {
    const model = buildPassengerViewModel(trip, new Map(), new Map());

    expect(model.legs).toContain('等候 l1（s1）・2 分');
    expect(model.legs).toContain('l1：s1 → s2・10 分');
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

  it('uses CSS variables for passenger panel colors and typography', () => {
    const css = readFileSync(new URL('../../src/style.css', import.meta.url), 'utf8');
    const rules = css.match(/\.(?:passenger-follow-details|representative-passenger)(?:\s+[^,{]+)?\s*\{[^}]*\}/g) ?? [];

    expect(rules.length).toBeGreaterThan(0);
    expect(rules.join('\n')).not.toMatch(/#[\da-f]{3,8}\b/i);
    expect(rules.join('\n')).toMatch(/color:\s*var\(--panel-color-/);
    expect(rules.join('\n')).toMatch(/font-size:\s*var\(--panel-font-/);
  });
});
