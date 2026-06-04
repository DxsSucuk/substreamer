import ExpoAsyncFsModule from './ExpoAsyncFsModule';

import { type EventSubscription } from 'expo-modules-core';

export { type DownloadProgressEvent, type DirectoryEntry } from './ExpoAsyncFsModule';

/**
 * List directory contents asynchronously on a native background thread.
 * Returns an array of entry names (not full paths).
 */
export function listDirectoryAsync(uri: string): Promise<string[]> {
  return ExpoAsyncFsModule.listDirectoryAsync(uri);
}

/**
 * List directory contents with each entry's size and type in a single
 * off-thread native call. Avoids a sync `File.exists`/`File.size` stat per
 * child on the JS thread (those are sync-only in expo-file-system). `size` is
 * 0 for directories.
 */
export function listDirectoryWithSizesAsync(
  uri: string,
): Promise<import('./ExpoAsyncFsModule').DirectoryEntry[]> {
  return ExpoAsyncFsModule.listDirectoryWithSizesAsync(uri);
}

/**
 * Delete a single file on a native background thread. Resolves true if a file
 * existed and was deleted, false otherwise.
 */
export function deleteFileAsync(uri: string): Promise<boolean> {
  return ExpoAsyncFsModule.deleteFileAsync(uri);
}

/**
 * Recursively delete a directory and all its contents on a native background
 * thread (Android: Dispatchers.IO). For whole-cache wipes — expo-file-system's
 * `Directory.delete()` is sync-only and would block the JS thread unlinking
 * thousands of files. Resolves true if the directory existed and was removed.
 */
export function deleteDirectoryAsync(uri: string): Promise<boolean> {
  return ExpoAsyncFsModule.deleteDirectoryAsync(uri);
}

/**
 * Calculate total size (in bytes) of a directory recursively
 * on a native background thread.
 */
export function getDirectorySizeAsync(uri: string): Promise<number> {
  return ExpoAsyncFsModule.getDirectorySizeAsync(uri);
}

/**
 * Download a file on the native layer with progress events.
 * Returns the destination URI and total bytes written.
 */
export function downloadFileAsyncWithProgress(
  url: string,
  destinationUri: string,
  downloadId: string,
): Promise<{ uri: string; bytes: number }> {
  return ExpoAsyncFsModule.downloadFileAsyncWithProgress(url, destinationUri, downloadId);
}

/**
 * Subscribe to download progress events. Each event contains
 * downloadId, bytesWritten, and totalBytes (-1 if unknown).
 */
export function addDownloadProgressListener(
  listener: (event: { downloadId: string; bytesWritten: number; totalBytes: number }) => void,
): EventSubscription {
  return ExpoAsyncFsModule.addListener('onDownloadProgress', listener);
}
