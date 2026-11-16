export const FIXED_TICK_MS = 100;
export const SIM_SPEEDS = [1, 2, 4] as const;
export type SimSpeed = (typeof SIM_SPEEDS)[number];

export interface FixedStepClockOptions {
  maxCatchUpTicks?: number;
  initiallyPaused?: boolean;
}

/** Accumulates scaled wall time and emits fixed game-time ticks. */
export class FixedStepClock {
  private accumulatorMs = 0;
  private currentSpeed: SimSpeed = 1;
  private currentPaused: boolean;
  private readonly maxCatchUpTicks: number;

  constructor(options: FixedStepClockOptions = {}) {
    const maxCatchUpTicks = options.maxCatchUpTicks ?? 5;
    if (!Number.isSafeInteger(maxCatchUpTicks) || maxCatchUpTicks < 1) {
      throw new RangeError('maxCatchUpTicks must be a positive safe integer.');
    }
    this.maxCatchUpTicks = maxCatchUpTicks;
    this.currentPaused = options.initiallyPaused ?? true;
  }

  get paused(): boolean {
    return this.currentPaused;
  }

  get speed(): SimSpeed {
    return this.currentSpeed;
  }

  get remainderMs(): number {
    return this.accumulatorMs;
  }

  setPaused(paused: boolean): void {
    this.currentPaused = paused;
  }

  setSpeed(speed: SimSpeed): void {
    if (!SIM_SPEEDS.includes(speed)) throw new RangeError('Simulation speed must be 1, 2, or 4.');
    this.currentSpeed = speed;
  }

  advance(wallDeltaMs: number): number {
    if (!Number.isFinite(wallDeltaMs) || wallDeltaMs < 0) {
      throw new RangeError('wallDeltaMs must be a non-negative finite number.');
    }
    if (this.currentPaused || wallDeltaMs === 0) return 0;

    this.accumulatorMs += wallDeltaMs * this.currentSpeed;
    const availableTicks = Math.floor(this.accumulatorMs / FIXED_TICK_MS);
    if (availableTicks === 0) return 0;

    const ticks = Math.min(availableTicks, this.maxCatchUpTicks);
    if (availableTicks > this.maxCatchUpTicks) {
      // Drop whole excess ticks after a long stall while preserving the fractional remainder.
      this.accumulatorMs %= FIXED_TICK_MS;
    } else {
      this.accumulatorMs -= ticks * FIXED_TICK_MS;
    }
    return ticks;
  }
}
