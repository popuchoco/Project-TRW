import { FixedStepClock } from './clock';
import { IntervalScheduler } from './interval-scheduler';
import {
  isMainToWorkerMessage,
  isTransitMainToWorkerMessage,
  isTransitSnapshotMessage,
  type MainToWorkerMessage,
  type TransitMainToWorkerMessage,
} from './protocol';
import { TransitWorkerRuntime, type WorkerRuntimeOutput } from './worker-runtime';

interface WorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: WorkerRuntimeOutput): void;
}

const scope = globalThis as unknown as WorkerScope;
const clock = new FixedStepClock({ maxCatchUpTicks: 5 });
const pumpIntervalMs = 16;
let lastRecomputeMs = 0;
const runtime = new TransitWorkerRuntime();

function postOutputs(outputs: WorkerRuntimeOutput[]): void {
  for (const output of outputs) {
    if (isTransitSnapshotMessage(output)) {
      scope.postMessage({ type: 'snapshot', snapshot: { ...output.snapshot, recomputeMs: lastRecomputeMs } });
    } else {
      scope.postMessage(output);
    }
  }
}

function pump(): void {
  const ticks = clock.advance(pumpIntervalMs);
  for (let index = 0; index < ticks; index += 1) postOutputs(runtime.advanceTick());
}

const scheduler = new IntervalScheduler(pump, pumpIntervalMs);

function syncClockAndScheduler(): void {
  if (!runtime.started) return;
  clock.setSpeed(runtime.speed);
  clock.setPaused(runtime.isPaused);
  if (runtime.isPaused) scheduler.stop();
  else scheduler.start();
}

function isRuntimeInput(value: unknown): value is TransitMainToWorkerMessage | MainToWorkerMessage {
  return isTransitMainToWorkerMessage(value) || isMainToWorkerMessage(value);
}

let messageQueue = Promise.resolve();
scope.onmessage = (event: MessageEvent<unknown>): void => {
  if (!isRuntimeInput(event.data)) return;
  const message = event.data;
  const isTransitMessage = isTransitMainToWorkerMessage(message);
  const shouldMeasureRecompute = isTransitMessage
    && (message.type === 'start' || message.type === 'setNetwork' || message.type === 'loadState');
  const shouldResetClock = message.type === 'start' || (isTransitMessage && message.type === 'loadState');
  if (shouldResetClock) {
    scheduler.stop();
    clock.resetAccumulator();
    clock.setPaused(true);
  }

  messageQueue = messageQueue.then(async () => {
    const startedAt = shouldMeasureRecompute ? globalThis.performance.now() : 0;
    const outputs = await runtime.handle(message);
    if (shouldMeasureRecompute) {
      const elapsed = globalThis.performance.now() - startedAt;
      lastRecomputeMs = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
    }
    postOutputs(outputs);
    syncClockAndScheduler();
  }).catch((error: unknown) => {
    const requestId = 'requestId' in message ? message.requestId : undefined;
    scope.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : 'Simulation worker failed.',
      ...(typeof requestId === 'string' ? { requestId } : {}),
    });
    syncClockAndScheduler();
  });
};
