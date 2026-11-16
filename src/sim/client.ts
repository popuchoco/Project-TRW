import { FIXED_TICK_MS, type SimSpeed } from './clock';
import type { EntityState, SimSnapshot } from './core';
import { interpolateSnapshots } from './interpolate';
import type { WorkerToMainMessage } from './protocol';
import { isWorkerToMainMessage } from './protocol';

interface TimedSnapshot {
  snapshot: SimSnapshot;
  receivedAt: number;
}

export interface SimStatus {
  seq: number;
  gameTimeMs: number;
  paused: boolean;
  speed: SimSpeed;
}

export class SimClient {
  private readonly worker: Worker;
  private snapshots: TimedSnapshot[] = [];
  private currentPaused = true;
  private currentSpeed: SimSpeed = 1;
  private renderAnchorMs = 0;
  private renderAnchorAt = 0;
  private frozenRenderTimeMs?: number;

  constructor(private readonly onSnapshot?: (snapshot: SimSnapshot) => void) {
    this.worker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' });
    this.worker.addEventListener('message', this.handleMessage);
  }

  start(seed: number): void {
    this.currentPaused = false;
    this.worker.postMessage({ type: 'start', seed });
  }

  pause(now = performance.now()): void {
    if (this.currentPaused) return;
    this.frozenRenderTimeMs = this.renderTimeAt(now);
    this.currentPaused = true;
    this.worker.postMessage({ type: 'pause' });
  }

  resume(now = performance.now()): void {
    if (!this.currentPaused) return;
    this.renderAnchorMs = this.frozenRenderTimeMs ?? this.latest()?.snapshot.gameTimeMs ?? 0;
    this.renderAnchorAt = now;
    this.frozenRenderTimeMs = undefined;
    this.currentPaused = false;
    this.worker.postMessage({ type: 'resume' });
  }

  setSpeed(speed: SimSpeed, now = performance.now()): void {
    if (speed === this.currentSpeed) return;
    this.renderAnchorMs = this.renderTimeAt(now);
    this.renderAnchorAt = now;
    this.currentSpeed = speed;
    this.worker.postMessage({ type: 'setSpeed', speed });
  }

  getStatus(): SimStatus {
    const latest = this.latest()?.snapshot;
    return {
      seq: latest?.seq ?? 0,
      gameTimeMs: latest?.gameTimeMs ?? 0,
      paused: this.currentPaused,
      speed: this.currentSpeed,
    };
  }

  getInterpolatedEntities(now = performance.now()): EntityState[] {
    const latest = this.latest()?.snapshot;
    if (!latest) return [];
    const previous = this.snapshots.length > 1 ? this.snapshots[0]!.snapshot : latest;
    return interpolateSnapshots(previous, latest, this.renderTimeAt(now));
  }

  destroy(): void {
    this.worker.removeEventListener('message', this.handleMessage);
    this.worker.terminate();
  }

  private latest(): TimedSnapshot | undefined {
    return this.snapshots[this.snapshots.length - 1];
  }

  private renderTimeAt(now: number): number {
    if (this.frozenRenderTimeMs !== undefined) return this.frozenRenderTimeMs;
    if (this.snapshots.length < 2) return this.latest()?.snapshot.gameTimeMs ?? 0;
    const elapsed = this.currentPaused ? 0 : Math.max(0, now - this.renderAnchorAt) * this.currentSpeed;
    return this.renderAnchorMs + elapsed;
  }

  private readonly handleMessage = (event: MessageEvent<unknown>): void => {
    if (!isWorkerToMainMessage(event.data)) return;
    const message: WorkerToMainMessage = event.data;
    const receivedAt = performance.now();
    const priorLatest = this.latest();
    this.snapshots = [...this.snapshots, { snapshot: message.snapshot, receivedAt }].slice(-2);
    if (priorLatest) {
      this.renderAnchorMs = message.snapshot.gameTimeMs - FIXED_TICK_MS;
      this.renderAnchorAt = receivedAt;
      if (this.currentPaused && this.frozenRenderTimeMs === undefined) {
        this.frozenRenderTimeMs = this.renderAnchorMs;
      }
    } else {
      this.renderAnchorMs = message.snapshot.gameTimeMs;
      this.renderAnchorAt = receivedAt;
    }
    this.onSnapshot?.(message.snapshot);
  };
}
