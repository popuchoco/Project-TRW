import { FIXED_TICK_MS } from './clock';

export interface EntityState {
  id: string;
  lon: number;
  lat: number;
}

export interface SimSnapshot {
  seq: number;
  gameTimeMs: number;
  seed: number;
  rngState: number;
  routeProgress: number;
  entities: EntityState[];
}

export interface SimContinuationState {
  seed: number;
  rngState: number;
  seq: number;
  gameTimeMs: number;
  routeProgress: number;
}

export interface SimState {
  seed: number;
  rngState: number;
  seq: number;
  gameTimeMs: number;
  routeProgress: number;
  entities: EntityState[];
}

export type SimInput = { type: 'setRouteProgress'; progress: number };

const ROUTE: ReadonlyArray<readonly [number, number]> = [
  [121.5654, 25.033], // Taipei
  [121.6067, 23.9871], // Hualien
  [121.1444, 22.7554], // Taitung
  [120.3014, 22.6273], // Kaohsiung
  [120.2269, 22.9999], // Tainan
  [120.6736, 24.1477], // Taichung
  [121.5654, 25.033],
];

function nextRandom(rngState: number): { value: number; rngState: number } {
  let value = (rngState + 0x6d2b79f5) >>> 0;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  const nextState = (rngState + 0x6d2b79f5) >>> 0;
  return { value: ((value ^ (value >>> 14)) >>> 0) / 4294967296, rngState: nextState };
}

function routePosition(progress: number): readonly [number, number] {
  const wrapped = ((progress % 1) + 1) % 1;
  const scaled = wrapped * (ROUTE.length - 1);
  const index = Math.min(Math.floor(scaled), ROUTE.length - 2);
  const fraction = scaled - index;
  const start = ROUTE[index]!;
  const end = ROUTE[index + 1]!;
  return [start[0] + (end[0] - start[0]) * fraction, start[1] + (end[1] - start[1]) * fraction];
}

export function createSim(seed: number): SimState {
  if (!Number.isSafeInteger(seed)) throw new RangeError('Simulation seed must be a safe integer.');
  const normalizedSeed = seed >>> 0;
  const random = nextRandom(normalizedSeed);
  const routeProgress = random.value;
  const [lon, lat] = routePosition(routeProgress);
  return {
    seed: normalizedSeed,
    rngState: random.rngState,
    seq: 0,
    gameTimeMs: 0,
    routeProgress,
    entities: [{ id: 'dummy-train', lon, lat }],
  };
}

/** Restores the deterministic state needed to continue the fixed-step simulation. */
export function resumeSim(saved: SimContinuationState): SimState {
  if (!Number.isSafeInteger(saved.seed) || saved.seed < 0 || saved.seed > 0xffff_ffff ||
      !Number.isSafeInteger(saved.rngState) || saved.rngState < 0 || saved.rngState > 0xffff_ffff ||
      !Number.isSafeInteger(saved.seq) || saved.seq < 0 ||
      !Number.isFinite(saved.gameTimeMs) || saved.gameTimeMs < 0 ||
      !Number.isFinite(saved.routeProgress) || saved.routeProgress < 0 || saved.routeProgress >= 1) {
    throw new RangeError('Invalid simulation continuation state.');
  }
  const [lon, lat] = routePosition(saved.routeProgress);
  return {
    seed: saved.seed,
    rngState: saved.rngState,
    seq: saved.seq,
    gameTimeMs: saved.gameTimeMs,
    routeProgress: saved.routeProgress,
    entities: [{ id: 'dummy-train', lon, lat }],
  };
}

/** Advances one fixed 100 ms game tick without mutating the input state. */
export function step(state: SimState, inputs: readonly SimInput[] = []): SimState {
  let routeProgress = state.routeProgress;
  for (const input of inputs) {
    if (input.type === 'setRouteProgress') {
      if (!Number.isFinite(input.progress)) throw new RangeError('Route progress must be finite.');
      routeProgress = ((input.progress % 1) + 1) % 1;
    }
  }
  routeProgress = (routeProgress + 0.0008) % 1;
  const [lon, lat] = routePosition(routeProgress);
  return {
    ...state,
    seq: state.seq + 1,
    gameTimeMs: state.gameTimeMs + FIXED_TICK_MS,
    routeProgress,
    entities: [{ id: 'dummy-train', lon, lat }],
  };
}

export function snapshotOf(state: SimState): SimSnapshot {
  return {
    seq: state.seq,
    gameTimeMs: state.gameTimeMs,
    seed: state.seed,
    rngState: state.rngState,
    routeProgress: state.routeProgress,
    entities: state.entities.map((entity) => ({ ...entity })),
  };
}
