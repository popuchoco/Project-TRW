import { TRANSIT_MODES } from './modes';

// 可調：每個尖峰／離峰時段允許的最大列車數。
export const MAX_TRAINS_PER_PERIOD = 100_000;

// 可調：車站與路線名稱共用上限。
export const MAX_NAME_LENGTH = 80;

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isTrainCount(value: unknown): value is number {
  return isNonNegativeInteger(value) && value <= MAX_TRAINS_PER_PERIOD;
}

export function isValidTransitCars(mode: unknown, cars: unknown): cars is number {
  if (!isNonNegativeInteger(cars)) return false;
  if (mode === 'brt') return cars === TRANSIT_MODES.brt.carsFixed;
  if (mode === 'metro') return cars >= TRANSIT_MODES.metro.carsMin && cars <= TRANSIT_MODES.metro.carsMax;
  return false;
}
