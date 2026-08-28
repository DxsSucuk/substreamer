import { File, Paths } from 'expo-file-system';

import {
  LIBRARY_SYNC_DIAG_FLAG_FILE,
  LIBRARY_SYNC_DIAG_LOG_FILE,
  flushLibrarySyncLog,
  logLibrarySync,
  readLibrarySyncLogFlag,
  setLibrarySyncLogFlag,
} from '../librarySyncLogger';

// eslint-disable-next-line no-var
var mockFiles: Map<string, string>;
jest.mock('expo-file-system', () => {
  mockFiles = new Map<string, string>();
  class MockFile {
    name: string;
    constructor(_dir: unknown, name: string) {
      this.name = name;
    }
    get exists() {
      return mockFiles.has(this.name);
    }
    get size() {
      return mockFiles.get(this.name)?.length ?? 0;
    }
    get uri() {
      return `file:///${this.name}`;
    }
    create() {
      if (!mockFiles.has(this.name)) mockFiles.set(this.name, '');
    }
    write(text: string, opts?: { append?: boolean }) {
      mockFiles.set(this.name, opts?.append ? (mockFiles.get(this.name) ?? '') + text : text);
    }
    delete() {
      mockFiles.delete(this.name);
    }
    move(dest: { name: string }) {
      mockFiles.set(dest.name, mockFiles.get(this.name) ?? '');
      mockFiles.delete(this.name);
    }
  }
  return { File: MockFile, Paths: { document: '/doc' } };
});

beforeEach(() => {
  mockFiles.clear();
  setLibrarySyncLogFlag(false);
});

describe('librarySyncLogger', () => {
  it('writes nothing at all when the flag file is absent', async () => {
    readLibrarySyncLogFlag();

    logLibrarySync('album page offset=0');
    await flushLibrarySyncLog();

    expect(mockFiles.has(LIBRARY_SYNC_DIAG_LOG_FILE)).toBe(false);
  });

  it('writes buffered lines once enabled', async () => {
    new File(Paths.document, LIBRARY_SYNC_DIAG_FLAG_FILE).write('');
    readLibrarySyncLogFlag();

    logLibrarySync('run start reason=test');
    logLibrarySync('album page offset=0');
    await flushLibrarySyncLog();

    const text = mockFiles.get(LIBRARY_SYNC_DIAG_LOG_FILE) ?? '';
    expect(text).toContain('run start reason=test');
    expect(text).toContain('album page offset=0');
  });

  it('appends rather than rewriting, so a long sync does not re-move the whole file', async () => {
    new File(Paths.document, LIBRARY_SYNC_DIAG_FLAG_FILE).write('');
    readLibrarySyncLogFlag();

    logLibrarySync('first');
    await flushLibrarySyncLog();
    logLibrarySync('second');
    await flushLibrarySyncLog();

    const text = mockFiles.get(LIBRARY_SYNC_DIAG_LOG_FILE) ?? '';
    expect(text).toContain('first');
    expect(text).toContain('second');
  });

  it('drops buffered lines when logging is switched off', async () => {
    new File(Paths.document, LIBRARY_SYNC_DIAG_FLAG_FILE).write('');
    readLibrarySyncLogFlag();
    logLibrarySync('buffered');

    setLibrarySyncLogFlag(false);
    logLibrarySync('after-off');
    await flushLibrarySyncLog();

    expect(mockFiles.get(LIBRARY_SYNC_DIAG_LOG_FILE) ?? '').not.toContain('after-off');
  });

  it('reports the flag from disk, so a session that never opened Logging still logs', () => {
    expect(readLibrarySyncLogFlag()).toBe(false);
    new File(Paths.document, LIBRARY_SYNC_DIAG_FLAG_FILE).write('');
    expect(readLibrarySyncLogFlag()).toBe(true);
  });
});
