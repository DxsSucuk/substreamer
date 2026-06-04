import ExpoModulesCore
import Foundation

public class ExpoAsyncFsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoAsyncFs")

    Events("onDownloadProgress")

    AsyncFunction("listDirectoryAsync") { (uri: String) -> [String] in
      guard let url = URL(string: uri) else { return [] }
      let contents = try FileManager.default.contentsOfDirectory(atPath: url.path)
      return contents
    }

    AsyncFunction("getDirectorySizeAsync") { (uri: String) -> Int in
      guard let url = URL(string: uri) else { return 0 }
      return Self.directorySize(at: url)
    }

    // One off-thread call that returns each entry's name + size + type, so
    // callers avoid a sync .exists/.size stat per child on the JS thread
    // (expo-file-system's .exists/.size are sync-only). Used by
    // reconcileImageCache to walk the cover-art cache without blocking JS.
    AsyncFunction("listDirectoryWithSizesAsync") { (uri: String) -> [[String: Any]] in
      guard let url = URL(string: uri) else { return [] }
      let fm = FileManager.default
      let names = try fm.contentsOfDirectory(atPath: url.path)
      return names.map { name in
        let childPath = url.appendingPathComponent(name).path
        var isDir: ObjCBool = false
        fm.fileExists(atPath: childPath, isDirectory: &isDir)
        let size: Int = isDir.boolValue
          ? 0
          : ((try? fm.attributesOfItem(atPath: childPath)[.size] as? Int) ?? 0)
        return [
          "name": name,
          "size": size,
          "isDirectory": isDir.boolValue,
        ]
      }
    }

    // Off-thread file delete. Returns true if a file existed and was deleted.
    AsyncFunction("deleteFileAsync") { (uri: String) -> Bool in
      guard let url = URL(string: uri) else { return false }
      let fm = FileManager.default
      guard fm.fileExists(atPath: url.path) else { return false }
      try fm.removeItem(atPath: url.path)
      return true
    }

    // Off-thread RECURSIVE directory delete (whole cache wipe on logout /
    // clear-cache). expo-file-system's Directory.delete is sync-only and would
    // unlink potentially thousands of files on the JS thread. FileManager's
    // removeItem is recursive for directories.
    AsyncFunction("deleteDirectoryAsync") { (uri: String) -> Bool in
      guard let url = URL(string: uri) else { return false }
      let fm = FileManager.default
      guard fm.fileExists(atPath: url.path) else { return false }
      try fm.removeItem(atPath: url.path)
      return true
    }

    AsyncFunction("downloadFileAsyncWithProgress") { (urlString: String, destinationUri: String, downloadId: String) -> [String: Any] in
      guard let url = URL(string: urlString) else {
        throw DownloadError.invalidUrl
      }
      guard let destUrl = URL(string: destinationUri) else {
        throw DownloadError.invalidDestination
      }

      var request = URLRequest(url: url)
      request.cachePolicy = .reloadIgnoringLocalCacheData

      let config = URLSessionConfiguration.default
      config.requestCachePolicy = .reloadIgnoringLocalCacheData
      config.urlCache = nil

      var lastEventTime: TimeInterval = 0
      let delegate = DownloadProgressDelegate(
        destinationUrl: destUrl,
        onProgress: { [weak self] bytesWritten, totalBytes in
          let now = ProcessInfo.processInfo.systemUptime
          let isComplete = totalBytes > 0 && bytesWritten >= totalBytes
          guard now - lastEventTime >= 0.1 || isComplete else { return }
          lastEventTime = now
          self?.sendEvent("onDownloadProgress", [
            "downloadId": downloadId,
            "bytesWritten": bytesWritten,
            "totalBytes": totalBytes,
          ])
        }
      )

      let session = URLSession(
        configuration: config,
        delegate: delegate,
        delegateQueue: nil
      )

      defer { session.finishTasksAndInvalidate() }

      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
        delegate.continuation = continuation
        session.downloadTask(with: request).resume()
      }

      let fileSize = (try? FileManager.default.attributesOfItem(atPath: destUrl.path)[.size] as? Int64) ?? 0

      return [
        "uri": destUrl.absoluteString,
        "bytes": fileSize,
      ]
    }
  }

  private static func directorySize(at url: URL) -> Int {
    let fm = FileManager.default
    guard let enumerator = fm.enumerator(
      at: url,
      includingPropertiesForKeys: [.fileSizeKey],
      options: [.skipsHiddenFiles]
    ) else { return 0 }

    var total = 0
    for case let fileURL as URL in enumerator {
      total += (try? fileURL.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
    }
    return total
  }
}

private enum DownloadError: Error, LocalizedError {
  case invalidUrl
  case invalidDestination
  case httpError(Int)

  var errorDescription: String? {
    switch self {
    case .invalidUrl: return "Invalid download URL"
    case .invalidDestination: return "Invalid destination path"
    case .httpError(let code): return "Download failed with HTTP status \(code)"
    }
  }
}

/// Uses URLSession.downloadTask with a delegate — the same download
/// mechanism as expo-file-system's File.downloadFileAsync (which uses
/// the completion-handler variant). The delegate approach gives us the
/// additional didWriteData callback for progress events.
///
/// The temp file is moved to the destination inside didFinishDownloadingTo,
/// matching how expo-file-system moves it inside the completion handler.
/// iOS deletes the temp file once the callback returns, so the move
/// must happen before then.
private class DownloadProgressDelegate: NSObject, URLSessionDownloadDelegate {
  let destinationUrl: URL
  let onProgress: (Int64, Int64) -> Void
  var continuation: CheckedContinuation<Void, Error>?

  init(destinationUrl: URL, onProgress: @escaping (Int64, Int64) -> Void) {
    self.destinationUrl = destinationUrl
    self.onProgress = onProgress
  }

  func urlSession(
    _ session: URLSession,
    downloadTask: URLSessionDownloadTask,
    didWriteData bytesWritten: Int64,
    totalBytesWritten: Int64,
    totalBytesExpectedToWrite: Int64
  ) {
    onProgress(totalBytesWritten, totalBytesExpectedToWrite)
  }

  func urlSession(
    _ session: URLSession,
    downloadTask: URLSessionDownloadTask,
    didFinishDownloadingTo location: URL
  ) {
    let statusCode = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 200
    guard statusCode >= 200 && statusCode < 300 else {
      continuation?.resume(throwing: DownloadError.httpError(statusCode))
      continuation = nil
      return
    }

    do {
      if FileManager.default.fileExists(atPath: destinationUrl.path) {
        try FileManager.default.removeItem(at: destinationUrl)
      }
      try FileManager.default.moveItem(at: location, to: destinationUrl)
      continuation?.resume(returning: ())
    } catch {
      continuation?.resume(throwing: error)
    }
    continuation = nil
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didCompleteWithError error: Error?
  ) {
    guard let error = error else { return }
    continuation?.resume(throwing: error)
    continuation = nil
  }
}
