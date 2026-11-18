import { FIXED_TICK_MS, type SimSpeed } from './clock';
import type { Network } from '../city/network';
import { MAX_NAME_LENGTH } from '../city/limits';
import { createSim, resumeSim, type EntityState, type SimContinuationState, type SimSnapshot, type SimState } from './core';
import { interpolateSnapshots, interpolateTrainSnapshots } from './interpolate';
import { GAME_MS_PER_SIM_TICK } from './time';
import type {
  TransitWorkerSaveState,
  TransitWorkerSnapshot,
  LineFlowsMessage,
  VillageSource,
  WorkerToMainMessage,
} from './protocol';
import {
  isTransitLineFlowsMessage,
  isTransitWorkerSaveState,
  isTransitWorkerToMainMessage,
  isWorkerToMainMessage,
} from './protocol';
import type { RepresentativePassenger } from './transit/representative';

interface TimedSnapshot {
  snapshot: SimSnapshot;
  receivedAt: number;
}

export type SimClientSnapshot = SimSnapshot | TransitWorkerSnapshot;
export type InterpolatedTrainPositionFrame = TransitWorkerSnapshot['trains'] & { readonly gameTimeMs: number };

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
  private transitSnapshots: Array<{ snapshot: TransitWorkerSnapshot; receivedAt: number }> = [];
  private readonly snapshotSubscribers = new Set<(snapshot: SimClientSnapshot) => void>();
  private readonly lineFlowsSubscribers = new Set<(message: LineFlowsMessage) => void>();
  private readonly pendingRequests = new Map<string, {
    resolve: (value?: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private currentPaused = true;
  private currentSpeed: SimSpeed = 1;
  private protocol: 'legacy' | 'transit' = 'legacy';
  private requestSequence = 0;
  private renderAnchorMs = 0;
  private renderAnchorAt = 0;
  private frozenRenderTimeMs?: number;
  private initialState?: SimState;

  constructor(private readonly onSnapshot: ((snapshot: SimSnapshot) => void) | undefined, private readonly now: () => number) {
    this.worker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' });
    this.worker.addEventListener('message', this.handleMessage);
  }

  subscribe(listener: (snapshot: SimClientSnapshot) => void): () => void {
    this.snapshotSubscribers.add(listener);
    return () => { this.snapshotSubscribers.delete(listener); };
  }

  subscribeLineFlows(listener: (message: LineFlowsMessage) => void): () => void {
    this.lineFlowsSubscribers.add(listener);
    return () => { this.lineFlowsSubscribers.delete(listener); };
  }

  start(seed: number, continuation?: SimContinuationState, options: SimStartOptions = {}): void {
    this.protocol = 'legacy';
    this.snapshots = [];
    this.transitSnapshots = [];
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

  startTransit(
    seed: number,
    villages: VillageSource,
    network: Network,
    continuation?: TransitWorkerSaveState,
    options: SimStartOptions = {},
  ): void {
    this.protocol = 'transit';
    this.snapshots = [];
    this.transitSnapshots = [];
    this.initialState = undefined;
    this.currentPaused = options.paused ?? false;
    this.currentSpeed = options.speed ?? 1;
    this.worker.postMessage({
      type: 'start', seed, villages, network, state: continuation,
      paused: this.currentPaused, speed: this.currentSpeed,
    });
  }

  setNetwork(network: Network): void {
    if (this.protocol === 'transit') this.worker.postMessage({ type: 'setNetwork', network });
  }

  requestSaveState(): Promise<TransitWorkerSaveState> {
    if (this.protocol !== 'transit') return Promise.reject(new Error('Transit simulation has not started.'));
    const requestId = this.nextRequestId('save');
    return new Promise<TransitWorkerSaveState>((resolve, reject) => {
      this.pendingRequests.set(requestId, {
        resolve: (state) => isTransitWorkerSaveState(state)
          ? resolve(state)
          : reject(new Error('Worker returned no save state.')),
        reject,
      });
      this.worker.postMessage({ type: 'saveState', requestId });
    });
  }

  loadState(state: TransitWorkerSaveState): Promise<void> {
    if (this.protocol !== 'transit') return Promise.reject(new Error('Transit simulation has not started.'));
    const requestId = this.nextRequestId('load');
    return new Promise<void>((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve: () => resolve(), reject });
      this.worker.postMessage({ type: 'loadState', requestId, state });
    });
  }

  requestRepresentativePassenger(stationId: string): Promise<RepresentativePassenger | null> {
    if (this.protocol !== 'transit') return Promise.reject(new Error('Transit simulation has not started.'));
    const requestId = this.nextRequestId('representative');
    return new Promise<RepresentativePassenger | null>((resolve, reject) => {
      this.pendingRequests.set(requestId, {
        resolve: (passenger) => passenger === null || (typeof passenger === 'object' && passenger !== undefined)
          ? resolve(passenger as RepresentativePassenger | null)
          : reject(new Error('Worker returned an invalid representative passenger.')),
        reject,
      });
      this.worker.postMessage({ type: 'requestRepresentativePassenger', requestId, stationId });
    });
  }

  requestLineFlows(lineId?: string): Promise<LineFlowsMessage> {
    if (this.protocol !== 'transit') return Promise.reject(new Error('Transit simulation has not started.'));
    if (lineId !== undefined && (lineId.length === 0 || lineId.length > MAX_NAME_LENGTH)) {
      return Promise.reject(new Error('Line id is invalid.'));
    }
    const requestId = this.nextRequestId('line-flows');
    return new Promise<LineFlowsMessage>((resolve, reject) => {
      this.pendingRequests.set(requestId, {
        resolve: (message) => isTransitLineFlowsMessage(message)
          ? resolve(message)
          : reject(new Error('Worker returned invalid line flows.')),
        reject,
      });
      this.worker.postMessage({ type: 'requestLineFlows', requestId, ...(lineId === undefined ? {} : { lineId }) });
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
    const latest = this.protocol === 'transit' ? this.latestTransit()?.snapshot : this.latest()?.snapshot;
    return {
      seq: latest?.seq ?? 0,
      gameTimeMs: latest?.gameTimeMs ?? 0,
      paused: this.currentPaused,
      speed: this.currentSpeed,
    };
  }

  getSaveState(): SimClientSaveState {
    if (this.protocol === 'transit') throw new Error('Use requestSaveState() for a transit simulation.');
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
    if (this.protocol !== 'legacy') return [];
    const latest = this.latest()?.snapshot;
    if (!latest) return [];
    const previous = this.snapshots.length > 1 ? this.snapshots[0]!.snapshot : latest;
    return interpolateSnapshots(previous, latest, this.renderTimeAt(now));
  }

  getInterpolatedTrainPositions(now = this.now()): InterpolatedTrainPositionFrame {
    const gameTimeMs = this.renderTimeAt(now);
    if (this.protocol !== 'transit') {
      const positions: TransitWorkerSnapshot['trains'] = [];
      Object.defineProperty(positions, 'gameTimeMs', { value: gameTimeMs, enumerable: false });
      return positions as InterpolatedTrainPositionFrame;
    }
    const latest = this.latestTransit()?.snapshot;
    const positions = latest
      ? interpolateTrainSnapshots(
        this.transitSnapshots.length > 1 ? this.transitSnapshots[0]!.snapshot : latest,
        latest,
        gameTimeMs,
      )
      : [];
    Object.defineProperty(positions, 'gameTimeMs', {
      value: gameTimeMs,
      enumerable: false,
    });
    return positions as InterpolatedTrainPositionFrame;
  }

  destroy(): void {
    this.worker.removeEventListener('message', this.handleMessage);
    this.worker.terminate();
    this.snapshotSubscribers.clear();
    this.lineFlowsSubscribers.clear();
    for (const request of this.pendingRequests.values()) request.reject(new Error('Simulation worker was terminated.'));
    this.pendingRequests.clear();
  }

  private latest(): TimedSnapshot | undefined {
    return this.snapshots[this.snapshots.length - 1];
  }

  private renderTimeAt(now: number): number {
    if (this.frozenRenderTimeMs !== undefined) return this.frozenRenderTimeMs;
    const latestTime = this.protocol === 'transit'
      ? this.latestTransit()?.snapshot.gameTimeMs
      : this.latest()?.snapshot.gameTimeMs;
    const snapshotCount = this.protocol === 'transit' ? this.transitSnapshots.length : this.snapshots.length;
    if (snapshotCount < 2) return latestTime ?? 0;
    const elapsed = this.currentPaused ? 0 : Math.max(0, now - this.renderAnchorAt) * this.currentSpeed;
    return this.renderAnchorMs + elapsed;
  }

  private readonly handleMessage = (event: MessageEvent<unknown>): void => {
    if (isWorkerToMainMessage(event.data)) {
      const message: WorkerToMainMessage = event.data;
      const receivedAt = this.now();
      const priorLatest = this.latest();
      this.snapshots = [...this.snapshots, { snapshot: message.snapshot, receivedAt }].slice(-2);
      if (priorLatest) {
        this.renderAnchorMs = message.snapshot.gameTimeMs - FIXED_TICK_MS;
        this.renderAnchorAt = receivedAt;
        if (this.currentPaused && this.frozenRenderTimeMs === undefined) this.frozenRenderTimeMs = this.renderAnchorMs;
      } else {
        this.renderAnchorMs = message.snapshot.gameTimeMs;
        this.renderAnchorAt = receivedAt;
      }
      this.onSnapshot?.(message.snapshot);
      this.publishSnapshot(message.snapshot);
      return;
    }
    if (!isTransitWorkerToMainMessage(event.data)) return;
    const message = event.data;
    if (message.type === 'snapshot') {
      const receivedAt = this.now();
      const priorLatest = this.latestTransit();
      this.transitSnapshots = [...this.transitSnapshots, { snapshot: message.snapshot, receivedAt }].slice(-2);
      if (priorLatest) {
        this.renderAnchorMs = message.snapshot.gameTimeMs - GAME_MS_PER_SIM_TICK;
        this.renderAnchorAt = receivedAt;
        if (this.currentPaused && this.frozenRenderTimeMs === undefined) this.frozenRenderTimeMs = this.renderAnchorMs;
      } else {
        this.renderAnchorMs = message.snapshot.gameTimeMs;
        this.renderAnchorAt = receivedAt;
      }
      this.publishSnapshot(message.snapshot);
    } else if (message.type === 'lineFlows') {
      for (const subscriber of this.lineFlowsSubscribers) subscriber(message);
      if (message.requestId) {
        const request = this.pendingRequests.get(message.requestId);
        if (!request) return;
        this.pendingRequests.delete(message.requestId);
        request.resolve(message);
      }
    } else if (message.type === 'representativePassengerResult') {
      const request = this.pendingRequests.get(message.requestId);
      if (!request) return;
      this.pendingRequests.delete(message.requestId);
      request.resolve(message.passenger);
    } else if (message.type === 'saveStateResult' || message.type === 'loadStateResult') {
      const request = this.pendingRequests.get(message.requestId);
      if (!request) return;
      this.pendingRequests.delete(message.requestId);
      request.resolve(message.type === 'saveStateResult' ? message.state : undefined);
    } else if (message.type === 'error' && message.requestId) {
      const request = this.pendingRequests.get(message.requestId);
      if (!request) return;
      this.pendingRequests.delete(message.requestId);
      request.reject(new Error(message.message));
    }
  };

  private latestTransit(): { snapshot: TransitWorkerSnapshot; receivedAt: number } | undefined {
    return this.transitSnapshots[this.transitSnapshots.length - 1];
  }

  private publishSnapshot(snapshot: SimClientSnapshot): void {
    for (const subscriber of this.snapshotSubscribers) subscriber(snapshot);
  }

  private nextRequestId(action: 'save' | 'load' | 'representative' | 'line-flows'): string {
    this.requestSequence += 1;
    return `${action}-${this.requestSequence}`;
  }
}
