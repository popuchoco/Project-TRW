import { describe, expect, it, vi } from "vitest";
import { IntervalScheduler, type IntervalToken } from "../../src/sim/interval-scheduler";

describe("interval scheduler", () => {
  it("starts once, stops while paused, and starts again on resume", () => {
    const callback = vi.fn();
    const handles: IntervalToken[] = [];
    const cleared: IntervalToken[] = [];
    const scheduled: Array<{ callback: () => void; intervalMs: number }> = [];
    const start = vi.fn((scheduledCallback: () => void, intervalMs: number): IntervalToken => {
      scheduled.push({ callback: scheduledCallback, intervalMs });
      const token = handles.length + 1;
      handles.push(token);
      return token;
    });
    const stop = vi.fn((token: IntervalToken) => cleared.push(token));
    const scheduler = new IntervalScheduler(callback, 16, start, stop);

    scheduler.start();
    scheduler.start();
    expect(start).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledWith(callback, 16);

    scheduler.stop();
    scheduler.stop();
    expect(cleared).toEqual([1]);

    scheduler.start();
    expect(start).toHaveBeenCalledTimes(2);
    expect(handles).toEqual([1, 2]);
    expect(scheduled).toEqual([
      { callback, intervalMs: 16 },
      { callback, intervalMs: 16 },
    ]);
  });
});
