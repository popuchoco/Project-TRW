import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SimClient } from '../../src/sim/client';

class FakeWorker {
  static latest: FakeWorker | undefined;

  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  readonly messages: unknown[] = [];
  private readonly messageListeners = new Set<(event: MessageEvent<unknown>) => void>();

  constructor() {
    FakeWorker.latest = this;
  }

  addEventListener(type: string, listener: (event: MessageEvent<unknown>) => void): void {
    if (type === 'message') this.messageListeners.add(listener);
  }

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  dispatch(data: unknown): void {
    const event = { data } as MessageEvent<unknown>;
    this.onmessage?.(event);
    for (const listener of this.messageListeners) listener(event);
  }
}

describe('SimClient worker errors', () => {
  beforeEach(() => {
    FakeWorker.latest = undefined;
    vi.stubGlobal('Worker', FakeWorker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('notifies subscribers and logs errors without a request id', () => {
    const client = new SimClient(undefined, () => 0);
    const listener = vi.fn();
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {});
    client.subscribeErrors(listener);

    const worker = FakeWorker.latest;
    if (!worker) throw new Error('Fake worker was not created.');
    worker.dispatch({ type: 'error', message: 'Unable to start simulation.' });

    expect(listener).toHaveBeenCalledWith('Unable to start simulation.');
    expect(logError).toHaveBeenCalledWith('Simulation worker error:', 'Unable to start simulation.');
  });

  it('rejects only the request identified by an error request id', async () => {
    const client = new SimClient(undefined, () => 0);
    const listener = vi.fn();
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {});
    client.subscribeErrors(listener);
    client.startTransit(1, { kind: 'data', villages: [] }, {} as never);
    const saveRequest = client.requestSaveState();
    const passengerRequest = client.requestRepresentativePassenger('station-1');

    const worker = FakeWorker.latest;
    if (!worker) throw new Error('Fake worker was not created.');
    const requests = worker.messages.slice(-2) as Array<{ requestId: string }>;
    const [saveMessage, passengerMessage] = requests;
    if (!saveMessage || !passengerMessage) throw new Error('Expected two pending requests.');
    worker.dispatch({
      type: 'error',
      requestId: saveMessage.requestId,
      message: 'Unable to save simulation.',
    });

    await expect(saveRequest).rejects.toThrow('Unable to save simulation.');
    expect(listener).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();

    worker.dispatch({
      type: 'representativePassengerResult',
      requestId: passengerMessage.requestId,
      passenger: null,
    });
    await expect(passengerRequest).resolves.toBeNull();
  });
});
