import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Network } from '../../src/city/network';
import type { TransitWorkerSaveState, TransitWorkerSnapshot, VillageSource } from '../../src/sim/protocol';
import { TransitWorkerRuntime } from '../../src/sim/worker-runtime';

const raw = JSON.parse(readFileSync(resolve(process.cwd(), 'public/data/villages-6300065000.json'), 'utf8')) as Array<{
  VILLCODE: string;
  population: number;
  demandPoint: [number, number];
}>;
const villages: VillageSource = {
  kind: 'data',
  villages: raw.map(({ VILLCODE, population, demandPoint }) => ({ VILLCODE, population, demandPoint })),
};

/** Ten metro stations across central Taipei plus a crossing BRT line sharing one station. */
function scenarioNetwork(): Network {
  const stations = Array.from({ length: 10 }, (_, index) => ({
    id: `s${index + 1}`,
    name: `測試${index + 1}站`,
    lon: 121.46 + index * 0.014,
    lat: 25.02 + index * 0.004,
  }));
  stations.push({ id: 's11', name: '北端站', lon: 121.516, lat: 25.075 }, { id: 's12', name: '南端站', lon: 121.516, lat: 24.99 });
  return {
    nextId: 20,
    stations,
    lines: [
      { id: 'l13', mode: 'metro', stationIds: stations.slice(0, 10).map(({ id }) => id), peakTrains: 12, offPeakTrains: 6, cars: 4, color: '#c33', name: '測試捷運' },
      { id: 'l14', mode: 'brt', stationIds: ['s11', 's5', 's12'], peakTrains: 8, offPeakTrains: 4, cars: 1, color: '#36c', name: '測試BRT' },
    ],
  };
}

function lastSnapshot(outputs: Awaited<ReturnType<TransitWorkerRuntime['handle']>>): TransitWorkerSnapshot | undefined {
  const output = [...outputs].reverse().find((message) => message.type === 'snapshot');
  return output && 'trains' in output.snapshot ? output.snapshot : undefined;
}

function strip(snapshot: TransitWorkerSnapshot | undefined): unknown {
  if (!snapshot) return undefined;
  // recomputeMs is wall-clock instrumentation measured outside the deterministic state.
  return { ...snapshot, recomputeMs: 0 };
}

async function runScripted(runtime: TransitWorkerRuntime, ticks: number, editAt: number): Promise<TransitWorkerSnapshot | undefined> {
  let snapshot: TransitWorkerSnapshot | undefined;
  for (let tick = 0; tick < ticks; tick += 1) {
    if (tick === editAt) {
      const edited = scenarioNetwork();
      edited.lines[0] = { ...edited.lines[0]!, peakTrains: 3, offPeakTrains: 2 };
      snapshot = lastSnapshot(await runtime.handle({ type: 'setNetwork', network: edited })) ?? snapshot;
    }
    snapshot = lastSnapshot(runtime.advanceTick()) ?? snapshot;
  }
  return snapshot;
}

async function started(seed: number): Promise<TransitWorkerRuntime> {
  const runtime = new TransitWorkerRuntime();
  await runtime.handle({ type: 'start', seed, villages, network: scenarioNetwork(), paused: true, speed: 4 });
  await runtime.handle({ type: 'resume' });
  return runtime;
}

describe('worker-runtime determinism on committed 北北 data', () => {
  it('two independent runtimes with the same seed, network and edits produce identical snapshots', async () => {
    const first = await runScripted(await started(7), 2 * 1_440, 900);
    const second = await runScripted(await started(7), 2 * 1_440, 900);
    expect(first?.city.dailyRidership ?? 0).toBeGreaterThan(0);
    expect(strip(second)).toEqual(strip(first));
  });

  it('save at day 1 and load into a fresh runtime continues identically', async () => {
    const uninterrupted = await started(7);
    await runScripted(uninterrupted, 1_440, -1);
    const saveOutputs = await uninterrupted.handle({ type: 'saveState', requestId: 'save' });
    const saveResult = saveOutputs.find((message) => message.type === 'saveStateResult');
    if (!saveResult || !('state' in saveResult)) throw new Error('Expected save state.');
    const saved = JSON.parse(JSON.stringify(saveResult.state)) as TransitWorkerSaveState;

    const restored = new TransitWorkerRuntime();
    await restored.handle({ type: 'start', seed: 0, villages, network: { nextId: 1, stations: [], lines: [] }, paused: true, speed: 4 });
    await restored.handle({ type: 'loadState', requestId: 'load', state: saved });
    await restored.handle({ type: 'resume' });

    const a = await runScripted(uninterrupted, 1_440, 300);
    const b = await runScripted(restored, 1_440, 300);
    expect(a?.city.dailyRidership ?? 0).toBeGreaterThan(0);
    expect(strip(b)).toEqual(strip(a));
  });
});
