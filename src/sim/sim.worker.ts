import { FixedStepClock } from './clock';
import { createSim, snapshotOf, step, type SimState } from './core';
import { isMainToWorkerMessage, type MainToWorkerMessage, type WorkerToMainMessage } from './protocol';

interface WorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: WorkerToMainMessage): void;
}

const scope = globalThis as unknown as WorkerScope;
const clock = new FixedStepClock({ maxCatchUpTicks: 5 });
let state: SimState | undefined;
let lastWallTime = 0;

function postSnapshot(): void {
  if (!state) return;
  scope.postMessage({ type: 'snapshot', snapshot: snapshotOf(state) });
}

function pump(): void {
  const now = performance.now();
  const wallDelta = Math.max(0, now - lastWallTime);
  lastWallTime = now;
  const ticks = clock.advance(wallDelta);
  for (let index = 0; index < ticks; index += 1) {
    if (!state) break;
    state = step(state);
    postSnapshot();
  }
}

scope.onmessage = (event: MessageEvent<unknown>): void => {
  if (!isMainToWorkerMessage(event.data)) return;
  const message: MainToWorkerMessage = event.data;
  if (message.type === 'start') {
    if (state) return;
    state = createSim(message.seed);
    clock.setPaused(false);
    lastWallTime = performance.now();
    postSnapshot();
    setInterval(pump, 16);
    return;
  }
  if (!state) return;
  if (message.type === 'pause') {
    pump();
    clock.setPaused(true);
    lastWallTime = performance.now();
  } else if (message.type === 'resume') {
    pump();
    lastWallTime = performance.now();
    clock.setPaused(false);
  } else if (message.type === 'setSpeed') {
    pump();
    clock.setSpeed(message.speed);
  }
};
