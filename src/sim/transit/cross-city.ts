import { compareText } from '../compare';

export interface CountyFlow {
  originCounty: string;
  destinationCounty: string;
  trips: number;
  fareRevenue: number;
}

export interface CountyFlowTotals {
  trips: number;
  fareRevenue: number;
}

function assertNonNegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite, non-negative number`);
  }
}

function flowKey(originCounty: string, destinationCounty: string): string {
  // Map key only (never serialized). NUL cannot appear in a county code, so the pair stays unambiguous
  // without allocating a JSON array per call in the demand hot loop.
  return `${originCounty}\u0000${destinationCounty}`;
}

function compareCountyFlows(a: CountyFlow, b: CountyFlow): number {
  return compareText(a.originCounty, b.originCounty)
    || compareText(a.destinationCounty, b.destinationCounty);
}

export function countyOfVillage(code: string): string {
  return code.slice(0, 5);
}

export function addIndexedCountyFlow(
  acc: Map<number, CountyFlowTotals>,
  pairIndex: number,
  trips: number,
  fare: number,
): void {
  if (!Number.isSafeInteger(pairIndex) || pairIndex < 0) {
    throw new RangeError('pairIndex must be a non-negative safe integer');
  }
  assertNonNegativeFinite(trips, 'trips');
  assertNonNegativeFinite(fare, 'fare');

  const current = acc.get(pairIndex);
  const nextTrips = (current?.trips ?? 0) + trips;
  const nextFareRevenue = (current?.fareRevenue ?? 0) + fare;
  assertNonNegativeFinite(nextTrips, 'trips total');
  assertNonNegativeFinite(nextFareRevenue, 'fare total');
  if (current) {
    current.trips = nextTrips;
    current.fareRevenue = nextFareRevenue;
  } else {
    acc.set(pairIndex, { trips: nextTrips, fareRevenue: nextFareRevenue });
  }
}

export function addCountyFlow(
  acc: Map<string, CountyFlow>,
  origin: string,
  destination: string,
  trips: number,
  fare: number,
): void {
  assertNonNegativeFinite(trips, 'trips');
  assertNonNegativeFinite(fare, 'fare');

  const originCounty = countyOfVillage(origin);
  const destinationCounty = countyOfVillage(destination);
  const key = flowKey(originCounty, destinationCounty);
  const current = acc.get(key);
  const nextTrips = (current?.trips ?? 0) + trips;
  const nextFareRevenue = (current?.fareRevenue ?? 0) + fare;
  assertNonNegativeFinite(nextTrips, 'trips total');
  assertNonNegativeFinite(nextFareRevenue, 'fare total');

  // Accumulators own their entries (scale/summarize return copies), so update in place
  // instead of allocating a new record on every demand pair.
  if (current) {
    current.trips = nextTrips;
    current.fareRevenue = nextFareRevenue;
  } else {
    acc.set(key, { originCounty, destinationCounty, trips: nextTrips, fareRevenue: nextFareRevenue });
  }
}

export function scaleCountyFlows(flows: ReadonlyMap<string, CountyFlow>, ratio: number): CountyFlow[] {
  assertNonNegativeFinite(ratio, 'ratio');

  return [...flows.values()]
    .map((flow) => {
      assertNonNegativeFinite(flow.trips, 'trips');
      assertNonNegativeFinite(flow.fareRevenue, 'fareRevenue');
      const scaled = {
        originCounty: flow.originCounty,
        destinationCounty: flow.destinationCounty,
        trips: flow.trips * ratio,
        fareRevenue: flow.fareRevenue * ratio,
      };
      assertNonNegativeFinite(scaled.trips, 'scaled trips');
      assertNonNegativeFinite(scaled.fareRevenue, 'scaled fareRevenue');
      return scaled;
    })
    .sort(compareCountyFlows);
}

export function summarizeCountyFlows(flows: readonly CountyFlow[]): {
  flows: CountyFlow[];
  crossCity: { trips: number; fareRevenue: number };
} {
  let trips = 0;
  let fareRevenue = 0;
  const sortedFlows = flows.map((flow) => {
    assertNonNegativeFinite(flow.trips, 'trips');
    assertNonNegativeFinite(flow.fareRevenue, 'fareRevenue');
    if (flow.originCounty !== flow.destinationCounty) {
      trips += flow.trips;
      fareRevenue += flow.fareRevenue;
      assertNonNegativeFinite(trips, 'cross-city trips');
      assertNonNegativeFinite(fareRevenue, 'cross-city fareRevenue');
    }
    return { ...flow };
  }).sort(compareCountyFlows);

  return { flows: sortedFlows, crossCity: { trips, fareRevenue } };
}
