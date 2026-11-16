import { describe, expect, it } from 'vitest';
import { FixedStepClock, FIXED_TICK_MS, type SimSpeed } from '../../src/sim/clock';
import { createSim, snapshotOf, step, type SimInput, type SimSnapshot } from '../../src/sim/core';
import { interpolateSnapshots } from '../../src/sim/interpolate';
import { isMainToWorkerMessage, isWorkerToMainMessage } from '../../src/sim/protocol';

function snapshotsFor(seed: number, tickCount: number): SimSnapshot[] {
  let state = createSim(seed);
  const snapshots = [snapshotOf(state)];
  for (let tick = 1; tick <= tickCount; tick += 1) {
    const inputs: SimInput[] = tick === 120
      ? [{ type: 'setRouteProgress', progress: 0.25 }]
      : tick === 320
        ? [{ type: 'setRouteProgress', progress: 0.75 }]
        : [];
    state = step(state, inputs);
    snapshots.push(snapshotOf(state));
  }
  return snapshots;
}

function snapshotsWithControlSchedule(seed: number): SimSnapshot[] {
  const clock = new FixedStepClock({ maxCatchUpTicks: 100 });
  clock.setPaused(false);
  let state = createSim(seed);
  const snapshots = [snapshotOf(state)];
  while (state.seq < 60) {
    if (state.seq === 10) {
      clock.setPaused(true);
      expect(clock.advance(2_000)).toBe(0);
      clock.setSpeed(2);
      clock.setPaused(false);
    } else if (state.seq === 30) {
      clock.setSpeed(4);
    }
    const ticks = clock.advance(FIXED_TICK_MS / clock.speed);
    for (let index = 0; index < ticks; index += 1) {
      state = step(state);
      snapshots.push(snapshotOf(state));
    }
  }
  return snapshots;
}

describe('simulation core determinism', () => {
  it('produces identical snapshots for the same seed and tick-indexed inputs', () => {
    expect(snapshotsFor(731, 500)).toEqual(snapshotsFor(731, 500));
  });

  it('uses the seed to choose a different initial route offset', () => {
    expect(createSim(1).entities).not.toEqual(createSim(2).entities);
  });

  it('repeats snapshots when pause and speed controls use the same tick schedule', () => {
    expect(snapshotsWithControlSchedule(812)).toEqual(snapshotsWithControlSchedule(812));
  });

  it('advances sequence and game time by exactly one fixed step', () => {
    const next = step(createSim(42));
    expect(next.seq).toBe(1);
    expect(next.gameTimeMs).toBe(FIXED_TICK_MS);
    expect(next.entities[0]?.id).toBe('dummy-train');
  });
});

describe('fixed-step simulation clock', () => {
  it('emits no ticks while paused', () => {
    const clock = new FixedStepClock();
    expect(clock.advance(5_000)).toBe(0);
    expect(clock.remainderMs).toBe(0);
  });

  it.each([[1, 10], [2, 20], [4, 40]] as const)(
    'emits %i× ticks at the selected speed over one second',
    (speed: SimSpeed, expectedTicks: number) => {
      const clock = new FixedStepClock({ maxCatchUpTicks: 100 });
      clock.setPaused(false);
      clock.setSpeed(speed);
      const ticks = clock.advance(1_000);
      expect(ticks).toBe(expectedTicks);
      let state = createSim(7);
      for (let index = 0; index < ticks; index += 1) state = step(state);
      expect(state.gameTimeMs).toBe(ticks * FIXED_TICK_MS);
    },
  );

  it('keeps an accumulator across uneven wall-time deltas', () => {
    const jittered = new FixedStepClock({ maxCatchUpTicks: 100 });
    const single = new FixedStepClock({ maxCatchUpTicks: 100 });
    jittered.setPaused(false);
    single.setPaused(false);
    const deltas = [7.5, 22.5, 35, 65, 103, 267, 500];
    const jitteredTicks = deltas.reduce((sum, delta) => sum + jittered.advance(delta), 0);
    expect(jitteredTicks).toBe(single.advance(deltas.reduce((sum, delta) => sum + delta, 0)));
    expect(jittered.remainderMs).toBe(single.remainderMs);
  });

  it('caps catch-up ticks after a long stall and drops excess whole ticks', () => {
    const clock = new FixedStepClock({ maxCatchUpTicks: 3 });
    clock.setPaused(false);
    expect(clock.advance(1_000)).toBe(3);
    expect(clock.remainderMs).toBe(0);
    expect(clock.advance(99)).toBe(0);
    expect(clock.advance(1)).toBe(1);
  });

  it('does not lose fractional time when paused and resumed', () => {
    const clock = new FixedStepClock();
    clock.setPaused(false);
    expect(clock.advance(60)).toBe(0);
    clock.setPaused(true);
    expect(clock.advance(1_000)).toBe(0);
    clock.setPaused(false);
    expect(clock.advance(40)).toBe(1);
  });
});

describe('snapshot interpolation', () => {
  const previous: SimSnapshot = {
    seq: 1,
    gameTimeMs: 100,
    entities: [{ id: 'dummy-train', lon: 120, lat: 23 }],
  };
  const next: SimSnapshot = {
    seq: 2,
    gameTimeMs: 200,
    entities: [{ id: 'dummy-train', lon: 122, lat: 25 }],
  };

  it.each([
    [100, 120, 23],
    [150, 121, 24],
    [200, 122, 25],
    [0, 120, 23],
    [500, 122, 25],
  ])('interpolates and clamps at render time %i', (time, lon, lat) => {
    expect(interpolateSnapshots(previous, next, time)).toEqual([{ id: 'dummy-train', lon, lat }]);
  });

  it('returns the same snapshot position when both snapshots are identical', () => {
    expect(interpolateSnapshots(previous, previous, 9_999)).toEqual(previous.entities);
  });
});

describe('simulation protocol validation', () => {
  it('accepts supported controls and snapshots', () => {
    expect(isMainToWorkerMessage({ type: 'start', seed: 7 })).toBe(true);
    expect(isMainToWorkerMessage({ type: 'setSpeed', speed: 4 })).toBe(true);
    expect(isWorkerToMainMessage({ type: 'snapshot', snapshot: snapshotOf(createSim(7)) })).toBe(true);
  });

  it('rejects invalid controls and malformed snapshots', () => {
    expect(isMainToWorkerMessage({ type: 'setSpeed', speed: 3 })).toBe(false);
    expect(isMainToWorkerMessage({ type: 'start', seed: 1.5 })).toBe(false);
    expect(isWorkerToMainMessage({ type: 'snapshot', snapshot: { seq: 1, gameTimeMs: 0, entities: [{ id: 'x', lon: NaN, lat: 2 }] } })).toBe(false);
  });
});
