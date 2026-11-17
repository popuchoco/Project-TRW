import { describe, expect, it } from 'vitest';
import { RenderScheduler } from '../../src/render/RenderScheduler';

function createFrameDriver() {
  let nextHandle = 1;
  const callbacks = new Map<number, (timestamp: number) => void>();
  const requestAnimationFrame = (callback: (timestamp: number) => void): number => {
    const handle = nextHandle;
    nextHandle += 1;
    callbacks.set(handle, callback);
    return handle;
  };
  const cancelAnimationFrame = (handle: number): void => { callbacks.delete(handle); };
  const frame = (timestamp: number): void => {
    const scheduled = [...callbacks.values()];
    callbacks.clear();
    for (const callback of scheduled) callback(timestamp);
  };
  return { requestAnimationFrame, cancelAnimationFrame, frame, pendingCount: () => callbacks.size };
}

describe('RenderScheduler', () => {
  it('does not render while idle', () => {
    const driver = createFrameDriver();
    let renderCount = 0;
    const scheduler = new RenderScheduler({
      render: () => { renderCount += 1; },
      requestAnimationFrame: driver.requestAnimationFrame,
      cancelAnimationFrame: driver.cancelAnimationFrame,
    });

    driver.frame(16);

    expect(renderCount).toBe(0);
    expect(scheduler.renderCount).toBe(0);
    expect(driver.pendingCount()).toBe(0);
  });

  it('coalesces multiple invalidations into one render in a frame', () => {
    const driver = createFrameDriver();
    let renderCount = 0;
    const scheduler = new RenderScheduler({
      render: () => { renderCount += 1; },
      requestAnimationFrame: driver.requestAnimationFrame,
      cancelAnimationFrame: driver.cancelAnimationFrame,
    });

    scheduler.invalidate();
    scheduler.invalidate();
    scheduler.invalidate();
    expect(driver.pendingCount()).toBe(1);
    driver.frame(16);

    expect(renderCount).toBe(1);
    expect(scheduler.renderCount).toBe(1);
    expect(driver.pendingCount()).toBe(0);
  });

  it('keeps rendering while the simulation runs with a visible train', () => {
    const driver = createFrameDriver();
    let renderCount = 0;
    const scheduler = new RenderScheduler({
      render: () => { renderCount += 1; },
      requestAnimationFrame: driver.requestAnimationFrame,
      cancelAnimationFrame: driver.cancelAnimationFrame,
    });
    scheduler.setSimulationActivity(true, true);

    driver.frame(16);
    driver.frame(33);

    expect(renderCount).toBe(2);
    expect(driver.pendingCount()).toBe(1);
  });

  it('respects the configured frame rate cap while animating', () => {
    const driver = createFrameDriver();
    let renderCount = 0;
    const scheduler = new RenderScheduler({
      render: () => { renderCount += 1; },
      requestAnimationFrame: driver.requestAnimationFrame,
      cancelAnimationFrame: driver.cancelAnimationFrame,
      maxFPS: 30,
    });
    scheduler.setSimulationActivity(true, true);

    driver.frame(16);
    driver.frame(33);
    driver.frame(50);
    driver.frame(67);
    driver.frame(84);

    expect(renderCount).toBe(3);
  });

  it('stays idle when the simulation runs without visible trains', () => {
    const driver = createFrameDriver();
    let renderCount = 0;
    const scheduler = new RenderScheduler({
      render: () => { renderCount += 1; },
      requestAnimationFrame: driver.requestAnimationFrame,
      cancelAnimationFrame: driver.cancelAnimationFrame,
    });
    scheduler.setSimulationActivity(true, false);

    driver.frame(16);

    expect(renderCount).toBe(0);
    expect(scheduler.renderCount).toBe(0);
    expect(driver.pendingCount()).toBe(0);
  });

  it('reports renders in the trailing second', () => {
    const driver = createFrameDriver();
    let now = 100;
    const scheduler = new RenderScheduler({
      render: () => {},
      requestAnimationFrame: driver.requestAnimationFrame,
      cancelAnimationFrame: driver.cancelAnimationFrame,
      now: () => now,
    });
    scheduler.invalidate();
    driver.frame(100);
    scheduler.invalidate();
    driver.frame(200);

    expect(scheduler.getRendersPerSecond()).toBe(2);
    now = 1200;
    expect(scheduler.getRendersPerSecond()).toBe(0);
  });
});
