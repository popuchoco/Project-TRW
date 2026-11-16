import { FIXED_TICK_MS, type SimSpeed } from './clock';
import { createSim, resumeSim, type EntityState, type SimContinuationState, type SimSnapshot, type SimState } from './core';
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

export interface SimClientSaveState extends SimContinuationState {
  speed: SimSpeed;
  paused: boolean;
}

export interface SimStartOptions {
  speed?: SimSpeed;
  paused?: boolean;
}

export class SimClient {
  private readonly worker: Worker;
  private snapshots: TimedSnapshot[] = [];
  private currentPaused = true;
  private currentSpeed: SimSpeed = 1;
  private renderAnchorMs = 0;
  private renderAnchorAt = 0;
  private frozenRenderTimeMs?: number;
  private initialState?: SimState;

  constructor(private readonly onSnapshot: ((snapshot: SimSnapshot) => void) | undefined, private readonly now: () => number) {
    this.worker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' });
    this.worker.addEventListener('message', this.handleMessage);
  }

  start(seed: number, continuation?: SimContinuationState, options: SimStartOptions = {}): void {
    this.initialState = continuation ? resumeSim(continuation) : createSim(seed);
    this.currentPaused = options.paused ?? false;
    this.currentSpeed = options.speed ?? 1;
    const { rngState, seq, gameTimeMs, routeProgress } = this.initialState;
    this.worker.postMessage({
      type: 'start',
      seed: this.initialState.seed,
      state: { seed: this.initialState.seed, rngState, seq, gameTimeMs, routeProgress },
      paused: this.currentPaused,
      speed: this.currentSpeed,
    });
  }

  pause(now = this.now()): void {
    if (this.currentPaused) return;
    this.frozenRenderTimeMs = this.renderTimeAt(now);
    this.currentPaused = true;
    this.worker.postMessage({ type: 'pause' });
  }

  resume(now = this.now()): void {
    if (!this.currentPaused) return;
    this.renderAnchorMs = this.frozenRenderTimeMs ?? this.latest()?.snapshot.gameTimeMs ?? 0;
    this.renderAnchorAt = now;
    this.frozenRenderTimeMs = undefined;
    this.currentPaused = false;
    this.worker.postMessage({ type: 'resume' });
  }

  setSpeed(speed: SimSpeed, now = this.now()): void {
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

  getSaveState(): SimClientSaveState {
    const snapshot = this.latest()?.snapshot;
    const state = snapshot ?? this.initialState ?? createSim(0);
    return {
      seed: state.seed,
      rngState: state.rngState,
      seq: state.seq,
      gameTimeMs: state.gameTimeMs,
      routeProgress: state.routeProgress,
      speed: this.currentSpeed,
      paused: this.currentPaused,
    };
  }

  getInterpolatedEntities(now = this.now()): EntityState[] {
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
    const receivedAt = this.now();
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
