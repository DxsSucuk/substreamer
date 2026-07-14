const mockFileInstances = new Map<string, { exists: boolean; size: number | null; deleted: boolean }>();

jest.mock('expo-file-system', () => {
  class MockFile {
    _name: string;
    constructor(_base: any, ...parts: string[]) {
      this._name = parts.join('/');
    }
    get exists() {
      return mockFileInstances.get(this._name)?.exists ?? false;
    }
    get size() {
      const entry = mockFileInstances.get(this._name);
      return entry?.exists ? entry.size : null;
    }
    write(_content: string) {
      mockFileInstances.set(this._name, { exists: true, size: 0, deleted: false });
    }
    delete() {
      const entry = mockFileInstances.get(this._name);
      if (entry) {
        entry.exists = false;
        entry.deleted = true;
      }
    }
  }
  class MockDirectory {
    uri = 'file:///document/';
  }
  return {
    File: MockFile,
    Directory: MockDirectory,
    Paths: { document: new MockDirectory() },
  };
});

import { voiceSearchDiagnosticsStore } from '../voiceSearchDiagnosticsStore';

const FLAG = 'voice-search-diagnostics-enabled';
const LOG = 'voice-search-diagnostics.log';
const OLD = 'voice-search-diagnostics.old.log';

beforeEach(() => {
  mockFileInstances.clear();
  voiceSearchDiagnosticsStore.setState({ enabled: false, logFileSize: null });
});

describe('voiceSearchDiagnosticsStore', () => {
  it('starts disabled with no log file', () => {
    const s = voiceSearchDiagnosticsStore.getState();
    expect(s.enabled).toBe(false);
    expect(s.logFileSize).toBeNull();
  });

  it('setEnabled creates / deletes the flag file', async () => {
    await voiceSearchDiagnosticsStore.getState().setEnabled(true);
    expect(mockFileInstances.get(FLAG)?.exists).toBe(true);
    await voiceSearchDiagnosticsStore.getState().setEnabled(false);
    expect(mockFileInstances.get(FLAG)?.exists).toBe(false);
  });

  it('resetLog deletes both log files', async () => {
    mockFileInstances.set(LOG, { exists: true, size: 1024, deleted: false });
    mockFileInstances.set(OLD, { exists: true, size: 2048, deleted: false });
    await voiceSearchDiagnosticsStore.getState().resetLog();
    expect(mockFileInstances.get(LOG)?.deleted).toBe(true);
    expect(mockFileInstances.get(OLD)?.deleted).toBe(true);
    expect(voiceSearchDiagnosticsStore.getState().logFileSize).toBeNull();
  });

  it('refreshStatus reads enabled state + log size', async () => {
    mockFileInstances.set(FLAG, { exists: true, size: 0, deleted: false });
    mockFileInstances.set(LOG, { exists: true, size: 4096, deleted: false });
    await voiceSearchDiagnosticsStore.getState().refreshStatus();
    expect(voiceSearchDiagnosticsStore.getState().enabled).toBe(true);
    expect(voiceSearchDiagnosticsStore.getState().logFileSize).toBe(4096);
  });

  it('refreshStatus reports disabled + null size when flag absent', async () => {
    await voiceSearchDiagnosticsStore.getState().refreshStatus();
    expect(voiceSearchDiagnosticsStore.getState().enabled).toBe(false);
    expect(voiceSearchDiagnosticsStore.getState().logFileSize).toBeNull();
  });
});
