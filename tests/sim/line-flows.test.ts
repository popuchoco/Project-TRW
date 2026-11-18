import { describe, expect, it } from 'vitest';
import { createEmptyNetwork, type Network } from '../../src/city/network';
import { TransitWorkerRuntime, type WorkerRuntimeOutput } from '../../src/sim/worker-runtime';
import type { LineFlowsMessage, TransitWorkerSaveState, VillageSource } from '../../src/sim/protocol';

const villages: VillageSource = { kind: 'data', villages: [] };

const network: Network = {
  nextId: 3,
  stations: [
    { id: 's1', name: '甲站', lon: 121.5, lat: 25 },
    { id: 's2', name: '乙站', lon: 121.51, lat: 25 },
  ],
  lines: [{
    id: 'l1', mode: 'metro', stationIds: ['s1', 's2'], peakTrains: 8, offPeakTrains: 4,
    cars: 3, color: '#123456', name: '測試線',
  }],
};

function lineFlows(outputs: WorkerRuntimeOutput[]): LineFlowsMessage[] {
  return outputs.filter((message): message is LineFlowsMessage => message.type === 'lineFlows');
}

function saveState(outputs: WorkerRuntimeOutput[]): TransitWorkerSaveState {
  const result = outputs.find((message) => message.type === 'saveStateResult');
  if (result?.type !== 'saveStateResult') throw new Error('Expected a save state result.');
  return result.state;
}

describe('worker line-flow messages', () => {
  it('sends once on period and day changes, with no repeats on ticks within a period', async () => {
    const runtime = new TransitWorkerRuntime();
    const started = await runtime.handle({ type: 'start', seed: 1, villages, network: createEmptyNetwork(), paused: false });
    expect(lineFlows(started)).toMatchObject([{ gameDay: 0, periodId: 'morningPeak', networkVersion: 1 }]);

    const sentAtTicks: Array<{ tick: number; gameDay: number; periodId: string }> = [];
    for (let tick = 1; tick <= 1_440; tick += 1) {
      const messages = lineFlows(runtime.advanceTick());
      if (messages[0]) sentAtTicks.push({ tick, gameDay: messages[0].gameDay, periodId: messages[0].periodId });
    }

    expect(sentAtTicks).toEqual([
      { tick: 240, gameDay: 0, periodId: 'offPeak' },
      { tick: 720, gameDay: 0, periodId: 'eveningPeak' },
      { tick: 960, gameDay: 0, periodId: 'night' },
      { tick: 1_440, gameDay: 1, periodId: 'morningPeak' },
    ]);
  });

  it('sends one unsolicited payload after start, network recompute, and load completion', async () => {
    const runtime = new TransitWorkerRuntime();
    const started = await runtime.handle({ type: 'start', seed: 1, villages, network: createEmptyNetwork(), paused: true });
    expect(lineFlows(started)).toHaveLength(1);
    expect(lineFlows(started)[0]?.networkVersion).toBe(1);

    const changed = await runtime.handle({ type: 'setNetwork', network });
    expect(lineFlows(changed)).toHaveLength(1);
    expect(lineFlows(changed)[0]).toMatchObject({ networkVersion: 2, lines: [{ lineId: 'l1' }] });

    const saved = saveState(await runtime.handle({ type: 'saveState', requestId: 'save-1' }));
    const loaded = await runtime.handle({ type: 'loadState', requestId: 'load-1', state: saved });
    expect(lineFlows(loaded)).toHaveLength(1);
    expect(lineFlows(loaded)[0]).toMatchObject({ networkVersion: 3, lines: [{ lineId: 'l1' }] });
  });

  it('answers all-line and single-line requests with the matching request id', async () => {
    const runtime = new TransitWorkerRuntime();
    await runtime.handle({ type: 'start', seed: 1, villages, network, paused: true });

    const all = lineFlows(await runtime.handle({ type: 'requestLineFlows', requestId: 'all-lines' }))[0];
    const one = lineFlows(await runtime.handle({ type: 'requestLineFlows', requestId: 'one-line', lineId: 'l1' }))[0];
    const unknown = lineFlows(await runtime.handle({ type: 'requestLineFlows', requestId: 'unknown-line', lineId: 'missing' }))[0];

    expect(all).toMatchObject({ type: 'lineFlows', requestId: 'all-lines', networkVersion: 1, lines: [{ lineId: 'l1' }] });
    expect(one).toMatchObject({ type: 'lineFlows', requestId: 'one-line', lines: [{ lineId: 'l1' }] });
    expect(unknown).toMatchObject({ type: 'lineFlows', requestId: 'unknown-line', lines: [] });
  });
});
