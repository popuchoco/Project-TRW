import { describe, expect, it } from 'vitest';
import { followReducer, type FollowState } from '../../src/city/follow';
import { isRenderFrameActive, RenderScheduler } from '../../src/render/RenderScheduler';

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

  it('marks the pre-render callback as an active render frame', () => {
    const driver = createFrameDriver();
    let activeDuringCallback = false;
    const scheduler = new RenderScheduler({
      render: () => {},
      requestAnimationFrame: driver.requestAnimationFrame,
      cancelAnimationFrame: driver.cancelAnimationFrame,
      beforeFrame: () => { activeDuringCallback = isRenderFrameActive(); },
    });
    scheduler.invalidate();
    driver.frame(16);

    expect(activeDuringCallback).toBe(true);
    expect(isRenderFrameActive()).toBe(false);
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

  it('does not render over five simulated seconds while paused with a train followed', () => {
    const driver = createFrameDriver();
    let renderCount = 0;
    const scheduler = new RenderScheduler({
      render: () => { renderCount += 1; },
      requestAnimationFrame: driver.requestAnimationFrame,
      cancelAnimationFrame: driver.cancelAnimationFrame,
    });
    const following: FollowState = followReducer({ kind: 'idle' }, {
      type: 'start', trainId: 'l1-train-1', lineId: 'l1',
    });
    scheduler.setSimulationActivity(false, true);

    for (let timestamp = 0; timestamp <= 5_000; timestamp += 100) driver.frame(timestamp);

    expect(following.kind).toBe('followingTrain');
    expect(renderCount).toBe(0);
    expect(scheduler.renderCount).toBe(0);
    expect(driver.pendingCount()).toBe(0);
  });

  it('does not render over five simulated seconds while paused with a representative passenger followed', () => {
    const driver = createFrameDriver();
    let renderCount = 0;
    const scheduler = new RenderScheduler({
      render: () => { renderCount += 1; },
      requestAnimationFrame: driver.requestAnimationFrame,
      cancelAnimationFrame: driver.cancelAnimationFrame,
    });
    const following: FollowState = followReducer({ kind: 'idle' }, {
      type: 'startPassenger',
      trip: {
        selectedStationId: 's1',
        odKey: 's1>s2',
        flow: 1,
        startStationId: 's1',
        endStationId: 's2',
        pathSignature: 'l1:s1>s2',
        legs: [{ kind: 'ride', minutes: 5, lineId: 'l1', fromStationId: 's1', toStationId: 's2' }],
        doorToDoorMinutes: 5,
        alternativeMinutes: null,
      },
      startGameTime: 0,
    });
    // MapRenderer reports visible activity while a passenger is followed; paused must still win.
    scheduler.setSimulationActivity(false, true);

    for (let timestamp = 0; timestamp <= 5_000; timestamp += 100) driver.frame(timestamp);

    expect(following.kind).toBe('followingPassenger');
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
