/**
 * Initial balance values for the first playable transit simulation.
 * Keep mode and simulation tuning here so a worker and UI share one source.
 */
export const TRANSIT_MODES = {
  brt: {
    id: 'brt',
    name: 'BRT',
    carsFixed: 1,
    capacityPerCar: 120,
    avgSpeedKmh: 22,
    recommendedSpacingKm: [0.4, 0.8],
    dwellSecondsPerStop: 20,
    operatingCostPerTrainHour: 1_800,
  },
  metro: {
    id: 'metro',
    name: '高運量捷運',
    carsMin: 3,
    carsMax: 6,
    defaultCars: 3,
    capacityPerCar: 330,
    avgSpeedKmh: 38,
    recommendedSpacingKm: [0.8, 1.5],
    dwellSecondsPerStop: 30,
    operatingCostPerTrainHour: 5_500,
  },
} as const;

export type TransitModeId = keyof typeof TRANSIT_MODES;

export const SIMULATION_BALANCE = {
  walkSpeedKmh: 4.5,
  walkDetourFactor: 1.3,
  walkAccessCapKm: 1.5,
  nearestStations: 3,
  transferPenaltySeconds: 300,
  alternativeMode: {
    name: '機車／汽車／公車（抽象替代方案）',
    speedKmh: 30,
    fixedTimeSeconds: 8 * 60,
  },
  logitScaleSeconds: 15 * 60,
  demandDistanceCapKm: 25,
  distanceDecay: {
    scaleKm: 3,
    exponent: 2,
  },
  // Uncalibrated game-demand scale, tuned to make low-service crowding visible.
  dailyTripsPerPerson: 5,
  habitTimeConstantDays: 7,
  fare: {
    base: 15,
    perKm: 2,
    maximum: 60,
  },
  // Durations sum to 24 game-hours. Demand shares are initial balance values.
  periods: [
    { id: 'morningPeak', name: '晨峰', durationHours: 4, demandShare: 0.32, usesPeakTrains: true },
    { id: 'offPeak', name: '離峰', durationHours: 8, demandShare: 0.23, usesPeakTrains: false },
    { id: 'eveningPeak', name: '昏峰', durationHours: 4, demandShare: 0.32, usesPeakTrains: true },
    { id: 'night', name: '夜間', durationHours: 8, demandShare: 0.13, usesPeakTrains: false },
  ],
} as const;

export type SimulationPeriod = (typeof SIMULATION_BALANCE.periods)[number];
export type SimulationPeriodId = SimulationPeriod['id'];

export const GAME_DAY_MS = 24 * 60 * 60 * 1_000;

