import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadVillageSource, TransitWorkerRuntime } from '../../src/sim/worker-runtime';
import { createEmptyNetwork, type Network } from '../../src/city/network';
import {
  isTransitWorkerSaveState,
  type TransitWorkerSaveState,
  type TransitWorkerSnapshot,
  type VillageSource,
} from '../../src/sim/protocol';

const villages: VillageSource = {
  kind: 'data',
  villages: [
    { VILLCODE: 'A', population: 50_000, demandPoint: [121.50, 25.03] },
    { VILLCODE: 'B', population: 50_000, demandPoint: [121.55, 25.03] },
  ],
};

const fixtureVillages: VillageSource = {
  kind: 'data',
  villages: [
    { VILLCODE: 'A', population: 50_000, demandPoint: [121.50, 25.03] },
    { VILLCODE: 'B', population: 40_000, demandPoint: [121.55, 25.03] },
    { VILLCODE: 'C', population: 30_000, demandPoint: [121.60, 25.05] },
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

async function requestLineFlows(runtime: TransitWorkerRuntime) {
  const outputs = await runtime.handle({ type: 'requestLineFlows', requestId: 'flows-1' });
  const output = outputs.find((message) => message.type === 'lineFlows');
  if (!output || output.type !== 'lineFlows') throw new Error('Expected line flows.');
  return output.lines;
}

describe('TransitWorkerRuntime', () => {
  it('loads and sorts villages from multiple URLs', async () => {
    const responses = {
      '/villages-a.json': [{ VILLCODE: 'C', population: 30, demandPoint: [123, 25] }],
      '/villages-b.json': [
        { VILLCODE: 'B', population: 20, demandPoint: [122, 25] },
        { VILLCODE: 'A', population: 10, demandPoint: [121, 25] },
      ],
    };
    const requestedUrls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      requestedUrls.push(url);
      return new Response(JSON.stringify(responses[url as keyof typeof responses]), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const loaded = await loadVillageSource({ kind: 'urls', urls: ['/villages-a.json', '/villages-b.json'] });
      expect(requestedUrls).toEqual(['/villages-a.json', '/villages-b.json']);
      expect(loaded).toEqual([
        { code: 'A', population: 10, lon: 121, lat: 25 },
        { code: 'B', population: 20, lon: 122, lat: 25 },
        { code: 'C', population: 30, lon: 123, lat: 25 },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects duplicate VILLCODE values across multiple URLs', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([
      { VILLCODE: 'A', population: 10, demandPoint: [121, 25] },
    ]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(loadVillageSource({ kind: 'urls', urls: ['/villages-a.json', '/villages-b.json'] }))
        .rejects.toThrow('duplicate VILLCODE A');
    } finally {
      vi.unstubAllGlobals();
    }
  });

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

  it('loads the pre-P1-1e save fixture and recomputes its legacy line flows', async () => {
    const parsedFixture: unknown = JSON.parse(readFileSync(
      new URL('../fixtures/transit-save-pre-p1-1e.json', import.meta.url),
      'utf8',
    ));
    expect(isTransitWorkerSaveState(parsedFixture)).toBe(true);
    if (!isTransitWorkerSaveState(parsedFixture)) throw new Error('Expected a valid transit save fixture.');

    const fixture = parsedFixture;
    const fixtureLines = fixture.transit.snapshot.lines;
    expect(fixtureLines.length).toBeGreaterThan(0);
    for (const line of fixtureLines) expect('sectionFlow' in line).toBe(true);

    const fixtureWithoutFlows = JSON.parse(JSON.stringify(fixture)) as TransitWorkerSaveState;
    for (const line of fixtureWithoutFlows.transit.snapshot.lines) {
      delete line.sectionFlow;
      delete line.stationFlows;
    }

    const loadAndRequestFlows = async (state: TransitWorkerSaveState) => {
      const runtime = new TransitWorkerRuntime();
      await runtime.handle({
        type: 'start', seed: 0, villages: fixtureVillages, network: createEmptyNetwork(), paused: true,
      });
      const outputs = await runtime.handle({ type: 'loadState', requestId: 'load-fixture', state });
      expect(outputs[0]).toEqual({ type: 'loadStateResult', requestId: 'load-fixture', ok: true });
      return requestLineFlows(runtime);
    };

    const fixtureFlows = await loadAndRequestFlows(fixture);
    const recomputedFlows = await loadAndRequestFlows(fixtureWithoutFlows);
    expect(fixtureFlows).toEqual(recomputedFlows);

    const loads = fixtureFlows.flatMap((line) => Object.values(line.sectionFlow).flatMap((period) => (
      [...period.forward, ...period.backward].map((segment) => segment.load)
    )));
    expect(loads.length).toBeGreaterThan(0);
    expect(loads.every((load) => Number.isFinite(load) && load >= 0)).toBe(true);
    expect(loads.some((load) => load > 0)).toBe(true);
  });

  it('omits line flows from saves and loads older saves that include them', async () => {
    const source = new TransitWorkerRuntime();
    await source.handle({ type: 'start', seed: 42, villages, network, paused: true });
    const saved = await saveState(source);
    for (const line of saved.transit.snapshot.lines) {
      expect('sectionFlow' in line).toBe(false);
      expect('stationFlows' in line).toBe(false);
    }

    const legacySaved = JSON.parse(JSON.stringify(saved)) as TransitWorkerSaveState;
    const sourceFlows = await requestLineFlows(source);
    for (const line of legacySaved.transit.snapshot.lines) {
      const flows = sourceFlows.find((candidate) => candidate.lineId === line.lineId);
      if (!flows) throw new Error(`Missing flows for ${line.lineId}.`);
      line.sectionFlow = flows.sectionFlow;
      line.stationFlows = flows.stationFlows;
    }
    expect(JSON.stringify(legacySaved).length).toBeGreaterThan(JSON.stringify(saved).length);

    const loadAndRequestFlows = async (state: TransitWorkerSaveState) => {
      const runtime = new TransitWorkerRuntime();
      await runtime.handle({
        type: 'start', seed: 0, villages, network: createEmptyNetwork(), paused: true,
      });
      const outputs = await runtime.handle({ type: 'loadState', requestId: 'load-1', state });
      expect(outputs[0]).toEqual({ type: 'loadStateResult', requestId: 'load-1', ok: true });
      return requestLineFlows(runtime);
    };

    const newSaveFlows = await loadAndRequestFlows(saved);
    const legacySaveFlows = await loadAndRequestFlows(legacySaved);
    expect(legacySaveFlows).toEqual(newSaveFlows);
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
