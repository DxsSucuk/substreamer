import { playbackToastStore } from '../playbackToastStore';

beforeEach(() => {
  jest.useFakeTimers();
  playbackToastStore.setState({
    status: 'idle',
    successLabel: null,
    _showedAt: 0,
  });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('playbackToastStore', () => {
  it('show sets loading status', () => {
    playbackToastStore.getState().show();
    expect(playbackToastStore.getState().status).toBe('loading');
  });

  it('succeed waits minimum duration before transitioning', () => {
    playbackToastStore.getState().show();
    playbackToastStore.getState().succeed();
    expect(playbackToastStore.getState().status).toBe('loading');
    jest.advanceTimersByTime(1200);
    expect(playbackToastStore.getState().status).toBe('success');
  });

  it('succeed transitions immediately when enough time has passed', () => {
    playbackToastStore.getState().show();
    jest.advanceTimersByTime(1500);
    playbackToastStore.getState().succeed();
    jest.advanceTimersByTime(0);
    expect(playbackToastStore.getState().status).toBe('success');
  });

  it('fail waits minimum duration before transitioning', () => {
    playbackToastStore.getState().show();
    playbackToastStore.getState().fail();
    expect(playbackToastStore.getState().status).toBe('loading');
    jest.advanceTimersByTime(1200);
    expect(playbackToastStore.getState().status).toBe('error');
  });

  it('fail transitions immediately when enough time has passed', () => {
    playbackToastStore.getState().show();
    jest.advanceTimersByTime(1500);
    playbackToastStore.getState().fail();
    jest.advanceTimersByTime(0);
    expect(playbackToastStore.getState().status).toBe('error');
  });

  it('hide resets to idle', () => {
    playbackToastStore.getState().show();
    playbackToastStore.getState().hide();
    expect(playbackToastStore.getState().status).toBe('idle');
  });

  it('last call wins when succeed and fail race', () => {
    playbackToastStore.getState().show();
    playbackToastStore.getState().succeed();
    playbackToastStore.getState().fail();
    jest.advanceTimersByTime(1200);
    expect(playbackToastStore.getState().status).toBe('error');
  });

  it('flashSuccess sets success status + custom label immediately (no loading delay)', () => {
    playbackToastStore.getState().flashSuccess('Added to download queue');
    const state = playbackToastStore.getState();
    expect(state.status).toBe('success');
    expect(state.successLabel).toBe('Added to download queue');
  });

  it('hide clears successLabel', () => {
    playbackToastStore.getState().flashSuccess('Done');
    playbackToastStore.getState().hide();
    expect(playbackToastStore.getState().successLabel).toBeNull();
  });

  it('show resets successLabel so a subsequent loading→success uses default label', () => {
    playbackToastStore.getState().flashSuccess('Custom');
    playbackToastStore.getState().show();
    expect(playbackToastStore.getState().successLabel).toBeNull();
  });
});
