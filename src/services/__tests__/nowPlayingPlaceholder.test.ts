const mockFileState = { exists: false, writes: [] as Array<{ content: string; encoding?: string }> };

jest.mock('expo-file-system', () => {
  class MockFile {
    _name: string;
    constructor(_base: unknown, name: string) {
      this._name = name;
    }
    get exists() {
      return mockFileState.exists;
    }
    get uri() {
      return `file:///doc/${this._name}`;
    }
    write(content: string, opts?: { encoding?: string }) {
      mockFileState.writes.push({ content, encoding: opts?.encoding });
      mockFileState.exists = true;
    }
  }
  return { File: MockFile, Paths: { document: {} } };
});

jest.mock('../nowPlayingPlaceholderData', () => ({
  NOWPLAYING_PLACEHOLDER_JPEG_BASE64: 'QUJD',
}));

import { ensureNowPlayingPlaceholderUri } from '../nowPlayingPlaceholder';

beforeEach(() => {
  mockFileState.exists = false;
  mockFileState.writes = [];
});

describe('ensureNowPlayingPlaceholderUri', () => {
  it('writes the placeholder as base64 and returns its file:// uri', () => {
    expect(ensureNowPlayingPlaceholderUri()).toBe('file:///doc/nowplaying-placeholder.jpg');
    // RNQP needs an on-disk file://; the base64 is decoded natively via the write option.
    expect(mockFileState.writes).toEqual([{ content: 'QUJD', encoding: 'base64' }]);
  });

  it('is idempotent — does not re-write when the file already exists', () => {
    mockFileState.exists = true;
    ensureNowPlayingPlaceholderUri();
    expect(mockFileState.writes).toEqual([]);
  });
});
