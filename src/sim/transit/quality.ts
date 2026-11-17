/** Tunable quality-score weights (可調). Keep these in sync with the formulas below. */
export const QUALITY_WEIGHTS = { wait: 0.3, transfer: 0.2, crowding: 0.3, denied: 0.2 } as const;

/** Tunable wait-score bounds in minutes (可調). */
export const WAIT_GOOD_MIN = 2;
export const WAIT_BAD_MIN = 10;

/** Tunable transfer-score bound, measured in transfers per passenger (可調). */
export const TRANSFER_BAD = 1.0;

/** Tunable crowding-score bounds (可調). */
export const CROWD_GOOD = 0.8;
export const CROWD_BAD = 1.2;

/** Tunable denied-boarding ratio at which the score reaches zero (可調). */
export const DENIED_BAD = 0.10;

export interface QualityScore {
  wait: number;
  transfer: number;
  crowding: number;
  denied: number;
  total: number;
}

export interface QualityMetrics {
  passengerCount: number;
  averageWaitMinutes: number;
  averageTransfers: number;
  averageLoadFactor: number;
  deniedRatio: number;
}

function requireFinite(value: number, metric: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${metric} must be finite.`);
  return value;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function scoreWait(averageWaitMinutes: number): number {
  const wait = requireFinite(averageWaitMinutes, 'Average wait');
  return 100 * clamp01(1 - (wait - WAIT_GOOD_MIN) / (WAIT_BAD_MIN - WAIT_GOOD_MIN));
}

export function scoreTransfers(averageTransfers: number): number {
  const transfers = requireFinite(averageTransfers, 'Average transfers');
  return 100 * clamp01(1 - transfers / TRANSFER_BAD);
}

export function scoreCrowding(averageLoadFactor: number): number {
  const loadFactor = requireFinite(averageLoadFactor, 'Average load factor');
  return 100 * clamp01(1 - (loadFactor - CROWD_GOOD) / (CROWD_BAD - CROWD_GOOD));
}

export function scoreDenied(deniedRatio: number): number {
  const ratio = requireFinite(deniedRatio, 'Denied-boarding ratio');
  return 100 * clamp01(1 - ratio / DENIED_BAD);
}

export function calculateQualityScore(metrics: QualityMetrics): QualityScore | null {
  const passengers = requireFinite(metrics.passengerCount, 'Passenger count');
  if (passengers < 0) throw new RangeError('Passenger count must be non-negative.');
  if (passengers === 0) return null;

  const wait = scoreWait(metrics.averageWaitMinutes);
  const transfer = scoreTransfers(metrics.averageTransfers);
  const crowding = scoreCrowding(metrics.averageLoadFactor);
  const denied = scoreDenied(metrics.deniedRatio);
  const weightTotal = QUALITY_WEIGHTS.wait + QUALITY_WEIGHTS.transfer
    + QUALITY_WEIGHTS.crowding + QUALITY_WEIGHTS.denied;
  const total = (
    wait * QUALITY_WEIGHTS.wait
    + transfer * QUALITY_WEIGHTS.transfer
    + crowding * QUALITY_WEIGHTS.crowding
    + denied * QUALITY_WEIGHTS.denied
  ) / weightTotal;
  return { wait, transfer, crowding, denied, total };
}
