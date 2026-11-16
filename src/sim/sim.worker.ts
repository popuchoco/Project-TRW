import { FixedStepClock } from './clock';
import { createSim, resumeSim, snapshotOf, step, type SimState } from './core';
import { IntervalScheduler } from './interval-scheduler';
import { isMainToWorkerMessage, type MainToWorkerMessage, type WorkerToMainMessage } from './protocol';

interface WorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: WorkerToMainMessage): void;
}

const scope = globalThis as unknown as WorkerScope;
const clock = new FixedStepClock({ maxCatchUpTicks: 5 });
let state: SimState | undefined;
const PUMP_INTERVAL_MS = 16;

function postSnapshot(): void {
  if (!state) return;
  scope.postMessage({ type: 'snapshot', snapshot: snapshotOf(state) });
}

function pump(): void {
  const ticks = clock.advance(PUMP_INTERVAL_MS);
  for (let index = 0; index < ticks; index += 1) {
    if (!state) break;
    state = step(state);
    postSnapshot();
  }
}

const pumpScheduler = new IntervalScheduler(pump, PUMP_INTERVAL_MS);

scope.onmessage = (event: MessageEvent<unknown>): void => {
  if (!isMainToWorkerMessage(event.data)) return;
  const message: MainToWorkerMessage = event.data;
  if (message.type === 'start') {
    if (state) return;
    state = message.state ? resumeSim(message.state) : createSim(message.seed);
    if (message.speed !== undefined) clock.setSpeed(message.speed);
    clock.setPaused(message.paused ?? false);
    postSnapshot();
    if (!clock.paused) pumpScheduler.start();
    return;
  }
  if (!state) return;
  if (message.type === 'pause') {
    pumpScheduler.stop();
    clock.setPaused(true);
  } else if (message.type === 'resume') {
    clock.setPaused(false);
    pumpScheduler.start();
  } else if (message.type === 'setSpeed') {
    clock.setSpeed(message.speed);
  }
};
