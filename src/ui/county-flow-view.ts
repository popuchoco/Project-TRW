import { compareText } from '../sim/compare';
import type { CountyFlow } from '../sim/transit/cross-city';

const countFormat = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 0 });
const moneyFormat = new Intl.NumberFormat('zh-TW', {
  style: 'currency',
  currency: 'TWD',
  maximumFractionDigits: 0,
});

function formatCountyCount(value: number): string {
  return countFormat.format(Math.round(value));
}

function formatCountyMoney(value: number): string {
  return moneyFormat.format(Math.round(value));
}

export const COUNTY_NAMES: Readonly<Record<string, string>> = {
  '63000': '臺北市',
  '65000': '新北市',
  '68000': '桃園市',
};

export function countyName(code: string): string {
  return COUNTY_NAMES[code] ?? code;
}

export interface CrossCityView {
  trips: string;
  fareRevenue: string;
  topPairs: string[];
}

const EMPTY_VIEW: CrossCityView = {
  trips: '—',
  fareRevenue: '—',
  topPairs: [],
};

function compareFlowsByTrips(a: CountyFlow, b: CountyFlow): number {
  return b.trips - a.trips
    || compareText(a.originCounty, b.originCounty)
    || compareText(a.destinationCounty, b.destinationCounty);
}

export function crossCityView(flows: readonly CountyFlow[] | undefined): CrossCityView {
  if (flows === undefined) return { ...EMPTY_VIEW, topPairs: [] };

  const crossCityFlows = flows.filter((flow) => flow.originCounty !== flow.destinationCounty);
  const trips = crossCityFlows.reduce((total, flow) => total + flow.trips, 0);
  const fareRevenue = crossCityFlows.reduce((total, flow) => total + flow.fareRevenue, 0);
  const topPairs = [...crossCityFlows]
    .sort(compareFlowsByTrips)
    .slice(0, 3)
    .map((flow) => (
      `${countyName(flow.originCounty)}→${countyName(flow.destinationCounty)} ${formatCountyCount(flow.trips)} 人`
    ));

  return {
    trips: `${formatCountyCount(trips)} 人次`,
    fareRevenue: formatCountyMoney(fareRevenue),
    topPairs,
  };
}
