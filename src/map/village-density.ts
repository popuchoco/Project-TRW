export const DEFAULT_DENSITY_CLASS_COUNT = 6;

/** Pale to deep teal, ordered from the lowest to highest density class. */
export const DENSITY_PALETTE = [0xf1f5f2, 0xd2e6df, 0xa8d2c8, 0x75b9ae, 0x3b958f, 0x176d70] as const;
export const UNMATCHED_VILLAGE_COLOR = 0x9da5a2;

export function populationDensity(population: number, areaKm2: number): number {
  if (!Number.isFinite(population) || population < 0) throw new RangeError('Population must be a finite non-negative number.');
  if (!Number.isFinite(areaKm2) || areaKm2 <= 0) throw new RangeError('Village area must be a finite positive number.');
  return population / areaKm2;
}

/** Return equal-frequency quantile thresholds for a 5–7 class sequential scale. */
export function buildDensityBreaks(
  densities: readonly number[],
  classCount = DEFAULT_DENSITY_CLASS_COUNT,
): number[] {
  if (!Number.isInteger(classCount) || classCount < 5 || classCount > 7) {
    throw new RangeError('Density class count must be between 5 and 7.');
  }
  const sorted = densities.map((density) => {
    if (!Number.isFinite(density) || density < 0) throw new RangeError('Density values must be finite and non-negative.');
    return density;
  }).sort((first, second) => first - second);
  if (sorted.length === 0) return Array.from({ length: classCount - 1 }, () => 0);

  return Array.from({ length: classCount - 1 }, (_, index) => {
    const position = ((index + 1) / classCount) * (sorted.length - 1);
    const lowerIndex = Math.floor(position);
    const upperIndex = Math.ceil(position);
    const fraction = position - lowerIndex;
    return sorted[lowerIndex]! + (sorted[upperIndex]! - sorted[lowerIndex]!) * fraction;
  });
}

/** Class index is 0-based; a value equal to a break stays in the lower class. */
export function densityClassIndex(density: number, breaks: readonly number[]): number {
  if (!Number.isFinite(density) || density < 0) throw new RangeError('Density must be finite and non-negative.');
  for (let index = 0; index < breaks.length; index += 1) {
    if (density <= breaks[index]!) return index;
  }
  return breaks.length;
}
