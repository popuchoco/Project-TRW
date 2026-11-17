import { describe, expect, it } from 'vitest';
import { loadVillageSource, TransitWorkerRuntime } from '../../src/sim/worker-runtime';
import { createEmptyNetwork, type Network } from '../../src/city/network';
import type { TransitWorkerSaveState, TransitWorkerSnapshot, VillageSource } from '../../src/sim/protocol';

const villages: VillageSource = {
  kind: 'data',
  villages: [
    { VILLCODE: 'A', population: 50_000, demandPoint: [121.50, 25.03] },
    { VILLCODE: 'B', population: 50_000, demandPoint: [121.55, 25.03] },
  ],
};

const network: Network = {
  nextId: 4,
  stations: [
    { id: 's1', name: 'A站', lon: 121.50, lat: 25.03 },
    { id: 's2', name: 'B站', lon: 121.55, lat: 25.03 },
  ],
  lines: [{
    id: 'l3', mode: 'brt', stationIds: ['s1', 's2'], peakTrains: 20, offPeakTrains: 10,
    cars: 1, color: '#123456', name: 'Test line',
  }],
};

function transitSnapshot(outputs: Awaited<ReturnType<TransitWorkerRuntime['handle']>>): TransitWorkerSnapshot {
  const output = outputs.find((message) => message.type === 'snapshot');
  if (!output || !('trains' in output.snapshot)) throw new Error('Expected a transit snapshot.');
  return output.snapshot;
}

async function saveState(runtime: TransitWorkerRuntime): Promise<TransitWorkerSaveState> {
  const outputs = await runtime.handle({ type: 'saveState', requestId: 'save-1' });
  const output = outputs.find((message) => message.type === 'saveStateResult');
  if (!output || !('state' in output)) throw new Error('Expected a save state result.');
  return JSON.parse(JSON.stringify(output.state)) as TransitWorkerSaveState;
}

describe('TransitWorkerRuntime', () => {
  it('rejects a fractional population while decoding village attributes', async () => {
    await expect(loadVillageSource({
      kind: 'data',
      villages: [{ VILLCODE: 'fractional', population: 1.5, demandPoint: [121, 25] }],
    } as unknown as VillageSource)).rejects.toThrow('invalid row');
  });

  it('recomputes a changed network and emits its updated snapshot from the handler', async () => {
    const runtime = new TransitWorkerRuntime();
    const started = await runtime.handle({
      type: 'start', seed: 9, villages, network: createEmptyNetwork(), paused: true,
    });
    expect(transitSnapshot(started).lines).toEqual([]);

    const updated = await runtime.handle({ type: 'setNetwork', network });
    expect(transitSnapshot(updated).lines).toHaveLength(1);
    expect(transitSnapshot(updated).pathRecomputeCount).toBe(2);
    expect(transitSnapshot(updated).recomputeMs).toBe(0);
  });

  it('continues identically after saving and loading through the handler', async () => {
    const uninterrupted = new TransitWorkerRuntime();
    await uninterrupted.handle({ type: 'start', seed: 42, villages, network, paused: true, speed: 4 });
    await uninterrupted.handle({ type: 'resume' });
    for (let tick = 0; tick < 1_440; tick += 1) uninterrupted.advanceTick();
    const saved = await saveState(uninterrupted);
    expect(saved.transit.gameTimeMs).toBe(86_400_000);

    const restored = new TransitWorkerRuntime();
    await restored.handle({ type: 'start', seed: 0, villages, network: createEmptyNetwork(), paused: true, speed: 4 });
    const loadResult = await restored.handle({ type: 'loadState', requestId: 'load-1', state: saved });
    expect(loadResult[0]).toEqual({ type: 'loadStateResult', requestId: 'load-1', ok: true });
    await restored.handle({ type: 'resume' });

    let uninterruptedSnapshot: TransitWorkerSnapshot | undefined;
    let restoredSnapshot: TransitWorkerSnapshot | undefined;
    for (let tick = 0; tick < 1_440; tick += 1) {
      uninterruptedSnapshot = transitSnapshot(uninterrupted.advanceTick());
      restoredSnapshot = transitSnapshot(restored.advanceTick());
    }
    expect(restoredSnapshot).toEqual(uninterruptedSnapshot);
  });

  it('applies pause, resume, and supported speeds to fixed tick handling', async () => {
    const runtime = new TransitWorkerRuntime();
    await runtime.handle({ type: 'start', seed: 1, villages, network, paused: true, speed: 2 });
    expect(runtime.advanceTick()).toEqual([]);
    expect(runtime.speed).toBe(2);
    await runtime.handle({ type: 'setSpeed', speed: 4 });
    await runtime.handle({ type: 'resume' });
    expect(runtime.advanceTick()).toHaveLength(1);
    expect(runtime.speed).toBe(4);
    await runtime.handle({ type: 'pause' });
    expect(runtime.advanceTick()).toEqual([]);
  });
});
