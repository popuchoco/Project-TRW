import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Network } from '../../src/city/network';
import { TransitSim, type VillageDemandPoint } from '../../src/sim/transit';

const rawVillages = JSON.parse(readFileSync(resolve(process.cwd(), 'public/data/villages-6300065000.json'), 'utf8')) as Array<{
  VILLCODE: string;
  population: number;
  demandPoint: [number, number];
}>;
const villages: VillageDemandPoint[] = rawVillages.map((village) => ({
  code: village.VILLCODE,
  population: village.population,
  lon: village.demandPoint[0],
  lat: village.demandPoint[1],
}));

function performanceNetwork(): Network {
  const stationSource = Array.from({ length: 200 }, (_, index) => rawVillages[Math.floor(index * rawVillages.length / 200)]!);
  const stations = stationSource.map((village, index) => ({
    id: `s${index + 1}`,
    name: `${village.VILLCODE}站`,
    lon: village.demandPoint[0],
    lat: village.demandPoint[1],
  }));
  const lines = Array.from({ length: 20 }, (_, lineIndex) => ({
    id: `l${lineIndex + 1}`,
    mode: 'metro' as const,
    stationIds: stations.slice(lineIndex * 10, lineIndex * 10 + 10).map(({ id }) => id),
    peakTrains: 12,
    offPeakTrains: 6,
    cars: 6,
    color: '#2255cc',
    name: `Benchmark ${lineIndex + 1}`,
  }));
  return { stations, lines, nextId: 221 };
}

describe('transit recompute performance report', () => {
  it('reports real-data pair count and 20-line/200-station dirty recompute time', () => {
    const constructionStartedAt = performance.now();
    const sim = new TransitSim(villages, performanceNetwork());
    const demandPairBuildMs = performance.now() - constructionStartedAt;
    const startedAt = performance.now();
    const snapshot = sim.advance(0);
    const elapsedMs = performance.now() - startedAt;
    console.info(
      `[transit-perf] villages=${villages.length} pairs=${snapshot.demandPairCount} pairBuildMs=${demandPairBuildMs.toFixed(1)} lines=20 stations=200 recomputeMs=${elapsedMs.toFixed(1)}`,
    );
    expect(snapshot.demandPairCount).toBeGreaterThan(0);
    expect(snapshot.pathRecomputeCount).toBe(1);
  });
});

