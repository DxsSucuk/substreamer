import { processingOverlayStore } from '../processingOverlayStore';

beforeEach(() => {
  jest.useFakeTimers();
  processingOverlayStore.setState({ status: 'idle', label: '', _showedAt: 0 });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('processingOverlayStore', () => {
  it('show sets processing status', () => {
    processingOverlayStore.getState().show('Working...');
    expect(processingOverlayStore.getState().status).toBe('processing');
    expect(processingOverlayStore.getState().label).toBe('Working...');
  });

  it('showSuccess waits minimum duration', () => {
    processingOverlayStore.getState().show('Working...');
    processingOverlayStore.getState().showSuccess('Done');
    expect(processingOverlayStore.getState().status).toBe('processing');
    jest.advanceTimersByTime(900);
    expect(processingOverlayStore.getState().status).toBe('success');
    expect(processingOverlayStore.getState().label).toBe('Done');
  });

  it('showSuccess transitions immediately when enough time has passed', () => {
    processingOverlayStore.getState().show('Working...');
    jest.advanceTimersByTime(1000);
    processingOverlayStore.getState().showSuccess('Done');
    jest.advanceTimersByTime(0);
    expect(processingOverlayStore.getState().status).toBe('success');
  });

  it('showError waits minimum duration', () => {
    processingOverlayStore.getState().show('Working...');
    processingOverlayStore.getState().showError('Failed');
    jest.advanceTimersByTime(900);
    expect(processingOverlayStore.getState().status).toBe('error');
    expect(processingOverlayStore.getState().label).toBe('Failed');
  });

  it('showError transitions immediately when enough time has passed', () => {
    processingOverlayStore.getState().show('Working...');
    jest.advanceTimersByTime(1000);
    processingOverlayStore.getState().showError('Oops');
    jest.advanceTimersByTime(0);
    expect(processingOverlayStore.getState().status).toBe('error');
  });

  it('hide resets to idle', () => {
    processingOverlayStore.getState().show('Working...');
    processingOverlayStore.getState().hide();
    expect(processingOverlayStore.getState().status).toBe('idle');
  });

  it('hide clears label', () => {
    processingOverlayStore.getState().show('Working...');
    processingOverlayStore.getState().hide();
    expect(processingOverlayStore.getState().label).toBe('');
  });

  it('last call wins when showSuccess and showError race', () => {
    processingOverlayStore.getState().show('Working...');
    processingOverlayStore.getState().showSuccess('Done');
    processingOverlayStore.getState().showError('Failed');
    jest.advanceTimersByTime(900);
    expect(processingOverlayStore.getState().status).toBe('error');
    expect(processingOverlayStore.getState().label).toBe('Failed');
  });

  it('cancels a pending success when hidden before the min-duration elapses', () => {
    processingOverlayStore.getState().show('Working...');
    processingOverlayStore.getState().showSuccess('Done');
    processingOverlayStore.getState().hide();
    jest.advanceTimersByTime(900);
    // The deferred success must not re-show over the dismissed op.
    expect(processingOverlayStore.getState().status).toBe('idle');
  });

  it('does not re-show a pending result after a reset (resetAllStores path)', () => {
    processingOverlayStore.getState().show('Working...');
    processingOverlayStore.getState().showSuccess('Done');
    // Simulate resetAllStores: state → idle without touching module timers.
    processingOverlayStore.setState({ status: 'idle', label: '', _showedAt: 0 });
    jest.advanceTimersByTime(900);
    expect(processingOverlayStore.getState().status).toBe('idle');
  });

  it('a new op supersedes a prior op pending result (last-op-wins)', () => {
    processingOverlayStore.getState().show('A');
    processingOverlayStore.getState().showSuccess('A done'); // deferred ~900ms
    processingOverlayStore.getState().show('B'); // clears A's pending timer
    jest.advanceTimersByTime(900);
    expect(processingOverlayStore.getState().status).toBe('processing');
    expect(processingOverlayStore.getState().label).toBe('B');
  });

  it('watchdog force-hides a hung processing state', () => {
    processingOverlayStore.getState().show('Working...');
    // Never resolves — no showSuccess/showError.
    jest.advanceTimersByTime(60000);
    expect(processingOverlayStore.getState().status).toBe('idle');
  });

  it('watchdog is cancelled once the op resolves', () => {
    processingOverlayStore.getState().show('Working...');
    processingOverlayStore.getState().showSuccess('Done');
    jest.advanceTimersByTime(60000);
    // Resolved to success (after the min-duration); watchdog did not fire.
    expect(processingOverlayStore.getState().status).toBe('success');
  });
});
