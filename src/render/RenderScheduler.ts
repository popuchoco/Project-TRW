export type AnimationFrameRequest = (callback: (timestamp: number) => void) => number;
export type AnimationFrameCancel = (handle: number) => void;

let activeRenderFrames = 0;

export function isRenderFrameActive(): boolean {
  return activeRenderFrames > 0;
}

export interface RenderSchedulerOptions {
  render: () => void;
  requestAnimationFrame?: AnimationFrameRequest;
  cancelAnimationFrame?: AnimationFrameCancel;
  now?: () => number;
  maxFPS?: number;
  beforeFrame?: (timestamp: number) => void;
  afterRender?: () => void;
}

/** Coalesces map invalidations and only keeps RAF active for visible train motion. */
export class RenderScheduler {
  private readonly renderFrame: () => void;
  private readonly requestFrame: AnimationFrameRequest;
  private readonly cancelFrame: AnimationFrameCancel;
  private readonly now: () => number;
  private beforeFrame?: (timestamp: number) => void;
  private readonly afterRender?: () => void;
  private frameHandle?: number;
  private frameRunning = false;
  private dirty = false;
  private enabled = true;
  private animating = false;
  private lastRenderAt?: number;
  private maxFPS: number;
  private totalRenderCount = 0;
  private readonly recentRenderTimes: number[] = [];

  constructor(options: RenderSchedulerOptions) {
    this.renderFrame = options.render;
    this.requestFrame = options.requestAnimationFrame ?? ((callback) => requestAnimationFrame(callback));
    this.cancelFrame = options.cancelAnimationFrame ?? ((handle) => cancelAnimationFrame(handle));
    this.now = options.now ?? (() => performance.now());
    this.maxFPS = options.maxFPS ?? 60;
    this.beforeFrame = options.beforeFrame;
    this.afterRender = options.afterRender;
    this.validateMaxFPS(this.maxFPS);
  }

  get renderCount(): number {
    return this.totalRenderCount;
  }

  setBeforeFrame(callback: ((timestamp: number) => void) | undefined): void {
    this.beforeFrame = callback;
  }

  setMaxFPS(maxFPS: number): void {
    this.validateMaxFPS(maxFPS);
    this.maxFPS = maxFPS;
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      this.cancelPendingFrame();
    } else {
      this.scheduleFrame();
    }
  }

  /** Rendering is continuous only when simulation is running and a train is visible. */
  setSimulationActivity(running: boolean, hasVisibleTrains: boolean): void {
    const shouldAnimate = running && hasVisibleTrains;
    if (this.animating === shouldAnimate) return;
    this.animating = shouldAnimate;
    if (this.animating) this.scheduleFrame();
    else if (!this.dirty) this.cancelPendingFrame();
  }

  invalidate(): void {
    this.dirty = true;
    this.scheduleFrame();
  }

  getRendersPerSecond(now = this.now()): number {
    this.pruneRenderTimes(now);
    return this.recentRenderTimes.length;
  }

  destroy(): void {
    this.cancelPendingFrame();
    this.dirty = false;
    this.animating = false;
    this.enabled = false;
  }

  private readonly handleFrame = (timestamp: number): void => {
    this.frameHandle = undefined;
    if (!this.enabled) return;

    const minimumFrameMs = 1000 / this.maxFPS;
    if (this.lastRenderAt !== undefined && timestamp - this.lastRenderAt < minimumFrameMs) {
      this.scheduleFrame();
      return;
    }
    if (!this.dirty && !this.animating) return;

    this.frameRunning = true;
    activeRenderFrames += 1;
    const shouldRender = this.dirty || this.animating;
    this.dirty = false;
    try {
      this.beforeFrame?.(timestamp);
      if (shouldRender || this.dirty || this.animating) {
        this.dirty = false;
        this.renderFrame();
        this.totalRenderCount += 1;
        this.lastRenderAt = timestamp;
        this.recentRenderTimes.push(timestamp);
        this.pruneRenderTimes(timestamp);
        this.afterRender?.();
      }
    } finally {
      activeRenderFrames -= 1;
      this.frameRunning = false;
      if (this.dirty || this.animating) this.scheduleFrame();
    }
  };

  private scheduleFrame(): void {
    if (!this.enabled || this.frameRunning || this.frameHandle !== undefined || (!this.dirty && !this.animating)) return;
    this.frameHandle = this.requestFrame(this.handleFrame);
  }

  private cancelPendingFrame(): void {
    if (this.frameHandle === undefined) return;
    this.cancelFrame(this.frameHandle);
    this.frameHandle = undefined;
  }

  private pruneRenderTimes(now: number): void {
    while (this.recentRenderTimes.length > 0 && this.recentRenderTimes[0]! <= now - 1000) {
      this.recentRenderTimes.shift();
    }
  }

  private validateMaxFPS(maxFPS: number): void {
    if (!Number.isFinite(maxFPS) || maxFPS <= 0) throw new RangeError('maxFPS must be a positive finite number.');
  }
}
