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
      const closePassengerFollow = vi.fn();
      const panels = createSimulationPanels(container as unknown as HTMLElement, {
        renameStation: vi.fn(),
        setLineTrains: vi.fn(),
        setLineCars: vi.fn(),
        followLine: vi.fn(),
        followPassenger: vi.fn(),
        replayPassenger,
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
      const actionButtons = buttons().filter((button) => ['重播', '關閉'].includes(button.textContent));
      expect(actionButtons.map((button) => button.textContent)).toEqual(['重播', '關閉']);
      expect(actionButtons.every((button) => button.type === 'button')).toBe(true);
      expect(actionButtons.map((button) => button.hidden)).toEqual([true, false]);
      actionButtons[1]?.click();
      expect(closePassengerFollow).toHaveBeenCalledOnce();

      panels.updateFollowInfo(undefined, trip, new Map(), new Map(), true);
      expect(descendants(container).some((node) => node.textContent === '行程已結束')).toBe(true);
      expect(actionButtons.map((button) => button.hidden)).toEqual([false, false]);
      actionButtons[0]?.click();
      expect(replayPassenger).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
