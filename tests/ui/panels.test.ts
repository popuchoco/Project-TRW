import { describe, expect, it, vi } from 'vitest';
import {
  createSimulationPanels,
  formatPanelCount,
  formatPanelDuration,
  formatPanelHeadway,
  formatPanelKm,
  formatPanelPercent,
} from '../../src/ui/panels';
import type { RepresentativePassenger } from '../../src/sim/transit/representative';

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly listeners = new Map<string, Array<() => void>>();
  parentElement?: FakeElement;
  hidden = false;
  className = '';
  type = '';
  value = '';
  maxLength = 0;
  required = false;
  title = '';
  private ownText = '';

  constructor(readonly tagName: string) {}

  get lastElementChild(): FakeElement | null {
    return this.children[this.children.length - 1] ?? null;
  }

  set textContent(value: string | null) { this.ownText = value ?? ''; }
  get textContent(): string { return this.ownText; }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.parentElement = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.children.length = 0;
    this.append(...nodes);
  }

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  setAttribute(): void {}
  remove(): void {
    if (this.parentElement) {
      const index = this.parentElement.children.indexOf(this);
      if (index >= 0) this.parentElement.children.splice(index, 1);
    }
  }
  click(): void { for (const listener of this.listeners.get('click') ?? []) listener(); }
}

function descendants(root: FakeElement): FakeElement[] {
  return [root, ...root.children.flatMap(descendants)];
}

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

describe('passenger follow actions', () => {
  it('shows replay and close controls according to trip state and wires callbacks', () => {
    const fakeDocument = {
      activeElement: undefined,
      createElement: (tag: string) => new FakeElement(tag),
      createElementNS: (_namespace: string, tag: string) => new FakeElement(tag),
    };
    vi.stubGlobal('document', fakeDocument as unknown as Document);
    try {
      const container = new FakeElement('div');
      const replayPassenger = vi.fn();
      const followAnotherPassenger = vi.fn();
      const closePassengerFollow = vi.fn();
      const panels = createSimulationPanels(container as unknown as HTMLElement, {
        renameStation: vi.fn(),
        setLineTrains: vi.fn(),
        setLineCars: vi.fn(),
        followLine: vi.fn(),
        followPassenger: vi.fn(),
        replayPassenger,
        followAnotherPassenger,
        closePassengerFollow,
      });
      const trip: RepresentativePassenger = {
        selectedStationId: 'station-a',
        odKey: 'station-a:station-b',
        flow: 1,
        startStationId: 'station-a',
        endStationId: 'station-b',
        pathSignature: 'station-a>station-b',
        legs: [],
        doorToDoorMinutes: 5,
        alternativeMinutes: null,
      };
      const buttons = (): FakeElement[] => descendants(container).filter((node) => node.tagName === 'button');

      panels.updateFollowInfo(undefined, trip, new Map(), new Map(), false);
      const actionButtons = buttons().filter((button) => ['重播', '選另一位', '關閉'].includes(button.textContent));
      expect(actionButtons.map((button) => button.textContent)).toEqual(['重播', '選另一位', '關閉']);
      expect(actionButtons.every((button) => button.type === 'button')).toBe(true);
      expect(actionButtons.map((button) => button.hidden)).toEqual([true, true, false]);
      actionButtons[2]?.click();
      expect(closePassengerFollow).toHaveBeenCalledOnce();

      panels.updateFollowInfo(undefined, trip, new Map(), new Map(), true);
      expect(descendants(container).some((node) => node.textContent === '行程已結束')).toBe(true);
      expect(actionButtons.map((button) => button.hidden)).toEqual([false, false, false]);
      actionButtons[0]?.click();
      actionButtons[1]?.click();
      expect(replayPassenger).toHaveBeenCalledOnce();
      expect(followAnotherPassenger).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('cross city panel values', () => {
  function createPanels() {
    const fakeDocument = {
      activeElement: undefined,
      createElement: (tag: string) => new FakeElement(tag),
      createElementNS: (_namespace: string, tag: string) => new FakeElement(tag),
    };
    vi.stubGlobal('document', fakeDocument as unknown as Document);
    const container = new FakeElement('div');
    const panels = createSimulationPanels(container as unknown as HTMLElement, {
      renameStation: vi.fn(),
      setLineTrains: vi.fn(),
      setLineCars: vi.fn(),
      followLine: vi.fn(),
      followPassenger: vi.fn(),
      replayPassenger: vi.fn(),
      followAnotherPassenger: vi.fn(),
      closePassengerFollow: vi.fn(),
    });
    return { container, panels };
  }

  function valueFor(container: FakeElement, label: string): string | undefined {
    const rowLabel = descendants(container).find((node) => node.textContent === label);
    return rowLabel?.parentElement?.children[1]?.textContent;
  }

  it('shows the three busiest county pairs and labels totals as simulated', () => {
    const { container, panels } = createPanels();
    try {
      panels.update(
        { stations: [], lines: [] } as unknown as Parameters<typeof panels.update>[0],
        {
          city: {
            countyFlows: [
              { originCounty: '65000', destinationCounty: '63000', trips: 100, fareRevenue: 500 },
              { originCounty: '63000', destinationCounty: '65000', trips: 80, fareRevenue: 300 },
              { originCounty: '65000', destinationCounty: '68000', trips: 50, fareRevenue: 200 },
              { originCounty: '63000', destinationCounty: '68000', trips: 20, fareRevenue: 100 },
              { originCounty: '65000', destinationCounty: '65000', trips: 999, fareRevenue: 9999 },
            ],
          },
          stations: [],
          lines: [],
        } as unknown as Parameters<typeof panels.update>[1],
      );

      expect(valueFor(container, '跨市旅次（模擬值）')).toBe('250 人次');
      expect(valueFor(container, '跨市票收（模擬值）')).toBe('$1,100');
      const pairList = descendants(container).find((node) => node.className === 'panel-list');
      expect(pairList?.children.map((pair) => pair.textContent)).toEqual([
        '新北市→臺北市 100 人',
        '臺北市→新北市 80 人',
        '新北市→桃園市 50 人',
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('shows dashes when county flows are unavailable', () => {
    const { container, panels } = createPanels();
    try {
      panels.update(
        { stations: [], lines: [] } as unknown as Parameters<typeof panels.update>[0],
        { city: {}, stations: [], lines: [] } as unknown as Parameters<typeof panels.update>[1],
      );

      expect(valueFor(container, '跨市旅次（模擬值）')).toBe('—');
      expect(valueFor(container, '跨市票收（模擬值）')).toBe('—');
      const pairList = descendants(container).find((node) => node.className === 'panel-list');
      expect(pairList?.children.map((pair) => pair.textContent)).toEqual(['—']);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
