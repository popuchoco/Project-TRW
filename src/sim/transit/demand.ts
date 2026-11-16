import { SIMULATION_BALANCE } from '../../city/modes';
import { haversineKm } from '../../city/network';

export interface VillageDemandPoint {
  code: string;
  population: number;
  lon: number;
  lat: number;
}

export interface VillagePair {
  /** Indices into the code-sorted village array. Pairs are unordered and unique. */
  first: number;
  second: number;
  distanceKm: number;
  gravityWeight: number;
}

export interface DemandParameters {
  distanceCapKm: number;
  distanceDecayScaleKm: number;
  distanceDecayExponent: number;
  dailyTripsPerPerson: number;
}

export interface VillageDemandModel {
  villages: VillageDemandPoint[];
  pairs: VillagePair[];
  totalPopulation: number;
  totalDailyTrips: number;
  totalDirectedGravityWeight: number;
  parameters: DemandParameters;
}

export const DEFAULT_DEMAND_PARAMETERS: DemandParameters = {
  distanceCapKm: SIMULATION_BALANCE.demandDistanceCapKm,
  distanceDecayScaleKm: SIMULATION_BALANCE.distanceDecay.scaleKm,
  distanceDecayExponent: SIMULATION_BALANCE.distanceDecay.exponent,
  dailyTripsPerPerson: SIMULATION_BALANCE.dailyTripsPerPerson,
};

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Builds unique unordered OD pairs with a regular spatial grid. Each positive
 * population village checks a fixed 7×7 neighborhood of grid cells, then uses
 * haversine distance for the exact cap filter. Work is O(N·k), where k is the
 * number of villages in nearby cells; output is at most N(N−1)/2 pairs (about
 * 1.14M for 1,512 villages), rather than a dense all-pairs matrix.
 */
export function buildVillageDemandModel(
  sourceVillages: readonly VillageDemandPoint[],
  overrides: Partial<DemandParameters> = {},
): VillageDemandModel {
  const parameters = { ...DEFAULT_DEMAND_PARAMETERS, ...overrides };
  if (!(parameters.distanceCapKm > 0)
    || !(parameters.distanceDecayScaleKm > 0)
    || !(parameters.distanceDecayExponent >= 0)
    || !(parameters.dailyTripsPerPerson >= 0)) {
    throw new RangeError('Demand parameters must be non-negative and use positive distance scales.');
  }

  const villages = sourceVillages.map((village) => ({ ...village })).sort((a, b) => compareText(a.code, b.code));
  for (const village of villages) {
    if (!Number.isFinite(village.population) || village.population < 0
      || !Number.isFinite(village.lon) || !Number.isFinite(village.lat)
      || village.lat < -90 || village.lat > 90) {
      throw new RangeError(`Invalid village demand point: ${village.code}`);
    }
  }

  const totalPopulation = villages.reduce((total, village) => total + village.population, 0);
  const active = villages
    .map((village, index) => ({ village, index }))
    .filter(({ village }) => village.population > 0);
  if (active.length < 2) {
    return { villages, pairs: [], totalPopulation, totalDailyTrips: 0, totalDirectedGravityWeight: 0, parameters };
  }

  const referenceLatitude = active.reduce((total, { village }) => total + village.lat, 0) / active.length;
  const referenceLatitudeRad = referenceLatitude * Math.PI / 180;
  const cellSizeKm = parameters.distanceCapKm / 2;
  const grid = new Map<string, number[]>();
  const projected = active.map(({ village, index }) => {
    const x = 6_371.0088 * Math.PI / 180 * village.lon * Math.cos(referenceLatitudeRad);
    const y = 6_371.0088 * Math.PI / 180 * village.lat;
    const cellX = Math.floor(x / cellSizeKm);
    const cellY = Math.floor(y / cellSizeKm);
    const key = `${cellX},${cellY}`;
    const cell = grid.get(key) ?? [];
    cell.push(index);
    grid.set(key, cell);
    return { index, cellX, cellY };
  });

  const pairs: VillagePair[] = [];
  const villagesWithPairs = new Set<number>();
  const distanceRange = 3;
  let undirectedGravityWeight = 0;
  for (const point of projected) {
    const origin = villages[point.index]!;
    for (let deltaX = -distanceRange; deltaX <= distanceRange; deltaX += 1) {
      for (let deltaY = -distanceRange; deltaY <= distanceRange; deltaY += 1) {
        const candidates = grid.get(`${point.cellX + deltaX},${point.cellY + deltaY}`);
        if (!candidates) continue;
        for (const destinationIndex of candidates) {
          if (destinationIndex <= point.index) continue;
          const destination = villages[destinationIndex]!;
          const distanceKm = haversineKm(origin.lon, origin.lat, destination.lon, destination.lat);
          if (distanceKm > parameters.distanceCapKm) continue;
          const scaledDistance = Math.max(0.05, distanceKm / parameters.distanceDecayScaleKm);
          const decay = 1 / (1 + scaledDistance ** parameters.distanceDecayExponent);
          const gravityWeight = origin.population * destination.population * decay;
          if (!(gravityWeight > 0) || !Number.isFinite(gravityWeight)) continue;
          pairs.push({ first: point.index, second: destinationIndex, distanceKm, gravityWeight });
          villagesWithPairs.add(point.index);
          villagesWithPairs.add(destinationIndex);
          undirectedGravityWeight += gravityWeight;
        }
      }
    }
  }

  return {
    villages,
    pairs,
    totalPopulation,
    totalDailyTrips: undirectedGravityWeight > 0
      ? [...villagesWithPairs].reduce((total, index) => total + villages[index]!.population, 0) * parameters.dailyTripsPerPerson
      : 0,
    totalDirectedGravityWeight: undirectedGravityWeight * 2,
    parameters,
  };
}

