import { type EventSubscription, requireNativeModule } from 'expo-modules-core';

export interface DownloadProgressEvent {
  downloadId: string;
  bytesWritten: number;
  totalBytes: number;
}

interface DownloadResult {
  uri: string;
  bytes: number;
}

export interface DirectoryEntry {
  name: string;
  size: number;
  isDirectory: boolean;
}

export interface StatResult {
  exists: boolean;
  size: number;
  isDirectory: boolean;
}

interface ExpoAsyncFsNativeModule {
  listDirectoryAsync(uri: string): Promise<string[]>;
  listDirectoryWithSizesAsync(uri: string): Promise<DirectoryEntry[]>;
  getDirectorySizeAsync(uri: string): Promise<number>;
  statAsync(uri: string): Promise<StatResult>;
  deleteFileAsync(uri: string): Promise<boolean>;
  deleteDirectoryAsync(uri: string): Promise<boolean>;
  downloadFileAsyncWithProgress(
    url: string,
    destinationUri: string,
    downloadId: string,
  ): Promise<DownloadResult>;
  addListener(eventName: string, listener: (event: DownloadProgressEvent) => void): EventSubscription;
}

let module: ExpoAsyncFsNativeModule;

try {
  module = requireNativeModule('ExpoAsyncFs');
} catch {
  console.warn(
    '[expo-async-fs] Native module not found. ' +
      'Run `npx expo run:ios` or `npx expo run:android` to rebuild with the native module.'
  );

  module = {
    listDirectoryAsync: () => Promise.resolve([]),
    listDirectoryWithSizesAsync: () => Promise.resolve([]),
    getDirectorySizeAsync: () => Promise.resolve(0),
    statAsync: () => Promise.resolve({ exists: false, size: 0, isDirectory: false }),
    deleteFileAsync: () => Promise.resolve(false),
    deleteDirectoryAsync: () => Promise.resolve(false),
    downloadFileAsyncWithProgress: () => Promise.resolve({ uri: '', bytes: 0 }),
    addListener: () => ({ remove: () => {} }),
  } as unknown as ExpoAsyncFsNativeModule;
}

export default module;
