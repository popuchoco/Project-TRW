import { describe, expect, it } from 'vitest';
import { followCameraTarget, followReducer, type FollowState } from '../../src/city/follow';

const idle: FollowState = { kind: 'idle' };

describe('train following', () => {
  it('starts following a selected train', () => {
    expect(followReducer(idle, { type: 'start', trainId: 'l1-train-1', lineId: 'l1' }))
      .toEqual({ kind: 'followingTrain', trainId: 'l1-train-1', lineId: 'l1' });
  });

  it.each([
    ['drag', { type: 'drag' }],
    ['Escape', { type: 'escape' }],
    ['train disappears', { type: 'trainGone', trainId: 'l1-train-1' }],
    ['line is deleted', { type: 'lineDeleted', lineId: 'l1' }],
  ] as const)('stops following when %s', (_label, event) => {
    const following: FollowState = { kind: 'followingTrain', trainId: 'l1-train-1', lineId: 'l1' };
    expect(followReducer(following, event)).toEqual(idle);
  });

  it('targets the interpolated position of the followed train', () => {
    const following: FollowState = { kind: 'followingTrain', trainId: 'l1-train-2', lineId: 'l1' };
    expect(followCameraTarget([
      { id: 'l1-train-1', lineId: 'l1', lon: 121, lat: 25 },
      { id: 'l1-train-2', lineId: 'l1', lon: 121.25, lat: 25.15 },
    ], following)).toEqual({ lon: 121.25, lat: 25.15 });
    expect(followCameraTarget([], following)).toBeUndefined();
  });
});
