import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addLine, addStation, haversineKm, type Network } from '../../src/city/network';
import { GAME_DAY_MS } from '../../src/city/modes';
import { TransitSim, type TransitSummarySnapshot } from '../../src/sim/transit';
import type { VillageDemandPoint } from '../../src/sim/transit/demand';

interface RawVillage {
  VILLCODE: string;
  name: string;
  TOWNCODE: string;
  townName: string;
  population: number;
  demandPoint: [number, number];
}

interface VillageLocation {
  village: VillageDemandPoint;
  lon: number;
  lat: number;
}

function readVillages(fileName: string): RawVillage[] {
  return JSON.parse(readFileSync(resolve(process.cwd(), fileName), 'utf8')) as RawVillage[];
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function villageNear(
  villages: readonly RawVillage[],
  townName: string,
  target: readonly [number, number],
): VillageLocation {
  const matches = villages
    .filter((village) => village.townName === townName && village.population > 0)
    .map((village) => ({
      village,
      distance: haversineKm(village.demandPoint[0], village.demandPoint[1], target[0], target[1]),
    }))
    .sort((a, b) => a.distance - b.distance || compareText(a.village.VILLCODE, b.village.VILLCODE));
  const selected = matches[0]?.village;
  if (!selected) throw new Error(`No positive-population village found in ${townName}.`);
  const [lon, lat] = selected.demandPoint;
  return {
    village: { code: selected.VILLCODE, population: selected.population, lon, lat },
    lon,
    lat,
  };
}

function createNetwork(seed: number, locations: {
  zhongli: VillageLocation;
  taoyuan: VillageLocation;
  guishan: VillageLocation;
  xinzhuang: VillageLocation;
  taipei: VillageLocation;
}): { network: Network; zhongliStationId: string } {
  let network: Network = { stations: [], lines: [], nextId: seed };
  const stationIds: Record<keyof typeof locations, string> = {} as Record<keyof typeof locations, string>;
  const stations: Array<[keyof typeof locations, string]> = [
    ['zhongli', '中壢'],
    ['taoyuan', '桃園'],
    ['guishan', '龜山'],
    ['xinzhuang', '新莊'],
    ['taipei', '臺北車站'],
  ];
  for (const [key, name] of stations) {
    const result = addStation(network, { ...locations[key], name });
    network = result.network;
    stationIds[key] = result.station.id;
  }

  let result = addLine(network, {
    name: '中壢－桃園 BRT',
    mode: 'brt',
    stationIds: [stationIds.zhongli, stationIds.taoyuan],
    peakTrains: 18,
    offPeakTrains: 12,
    cars: 1,
    color: '#247a9b',
  });
  network = result.network;
  result = addLine(network, {
    name: '桃園－臺北捷運',
    mode: 'metro',
    stationIds: [stationIds.taoyuan, stationIds.guishan, stationIds.xinzhuang, stationIds.taipei],
    peakTrains: 18,
    offPeakTrains: 12,
    cars: 3,
    color: '#b45435',
  });
  network = result.network;

  return { network, zhongliStationId: stationIds.zhongli };
}

function runScenario(
  seed: number,
  villages: readonly VillageDemandPoint[],
  locations: Parameters<typeof createNetwork>[1],
): { snapshot: TransitSummarySnapshot; zhongliRepresentativeRideCount: number } {
  const { network, zhongliStationId } = createNetwork(seed, locations);
  const simulation = new TransitSim(villages, network);
  const snapshot = simulation.advance(GAME_DAY_MS * 7);
  const passenger = simulation.representativePassenger(zhongliStationId);
  return {
    snapshot,
    zhongliRepresentativeRideCount: passenger?.legs.filter(({ kind }) => kind === 'ride').length ?? 0,
  };
}

describe('跨市真資料旅次與票收', () => {
  it('保留跨市雙向旅次、票收加總與跨線代表旅次，且固定 seed 重跑一致', () => {
    const rawVillages = [
      ...readVillages('public/data/villages-6300065000.json'),
      ...readVillages('public/data/villages-68000.json'),
    ];
    const locations = {
      zhongli: villageNear(rawVillages, '中壢區', [121.217, 24.953]),
      taoyuan: villageNear(rawVillages, '桃園區', [121.311, 24.991]),
      guishan: villageNear(rawVillages, '龜山區', [121.365, 25.002]),
      xinzhuang: villageNear(rawVillages, '新莊區', [121.45, 25.036]),
      taipei: villageNear(rawVillages, '中正區', [121.517, 25.047]),
    };
    // The Taoyuan village anchors the shared stop; demand stays to one real point per
    // other area so a Zhongli representative journey must transfer from BRT to metro.
    const villages = [
      locations.zhongli.village,
      locations.guishan.village,
      locations.xinzhuang.village,
      locations.taipei.village,
    ];
    const seed = 41;
    const first = runScenario(seed, villages, locations);
    const second = runScenario(seed, villages, locations);
    const snapshot = first.snapshot;
    const flows = snapshot.city.countyFlows ?? [];
    const totalFlowTrips = flows.reduce((total, flow) => total + flow.trips, 0);
    const totalFlowFare = flows.reduce((total, flow) => total + flow.fareRevenue, 0);

    expect(first).toEqual(second);
    expect(first.zhongliRepresentativeRideCount).toBe(2);
    expect(flows.reduce((total, flow) => total + flow.trips, 0)).toBeGreaterThan(0);
    expect(flows.reduce((total, flow) => total + flow.fareRevenue, 0)).toBeGreaterThan(0);
    expect(totalFlowTrips).toBeCloseTo(snapshot.city.dailyRidership, 8);
    expect(totalFlowFare).toBeCloseTo(snapshot.city.fareRevenue, 8);
    expect(flows).toEqual([...flows].sort((a, b) => (
      compareText(a.originCounty, b.originCounty)
      || compareText(a.destinationCounty, b.destinationCounty)
    )));

    const taipeiToTaoyuan = flows.find((flow) => (
      flow.originCounty === '63000' && flow.destinationCounty === '68000'
    ));
    const taoyuanToTaipei = flows.find((flow) => (
      flow.originCounty === '68000' && flow.destinationCounty === '63000'
    ));
    expect(taipeiToTaoyuan?.trips ?? 0).toBeGreaterThan(0);
    expect(taoyuanToTaipei?.trips ?? 0).toBeGreaterThan(0);
  }, 25_000);
});
