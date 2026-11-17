import type { TrainPosition } from '../sim/protocol';

export type FollowState =
  | { kind: 'idle' }
  | { kind: 'followingTrain'; trainId: string; lineId: string };

export type FollowEvent =
  | { type: 'start'; trainId: string; lineId: string }
  | { type: 'drag' }
  | { type: 'escape' }
  | { type: 'trainGone'; trainId: string }
  | { type: 'lineDeleted'; lineId: string };

export interface FollowTrainDisplay {
  lineId: string;
  lineName: string;
  direction: '順向' | '逆向';
  nextStationName: string;
}

export interface FollowTrainInfo extends FollowTrainDisplay {
  loadFactor?: number;
}

const IDLE: FollowState = { kind: 'idle' };

export function followReducer(state: FollowState, event: FollowEvent): FollowState {
  if (event.type === 'start') return { kind: 'followingTrain', trainId: event.trainId, lineId: event.lineId };
  if (state.kind === 'idle') return state;
  if (event.type === 'drag' || event.type === 'escape') return IDLE;
  if (event.type === 'trainGone' && event.trainId === state.trainId) return IDLE;
  if (event.type === 'lineDeleted' && event.lineId === state.lineId) return IDLE;
  return state;
}

/** Returns the interpolated position of the followed train, or undefined when it is unavailable. */
export function followCameraTarget(
  trainPositions: readonly TrainPosition[],
  state: FollowState,
): Pick<TrainPosition, 'lon' | 'lat'> | undefined {
  if (state.kind === 'idle') return undefined;
  const train = trainPositions.find(({ id, lineId }) => id === state.trainId && lineId === state.lineId);
  return train ? { lon: train.lon, lat: train.lat } : undefined;
}
