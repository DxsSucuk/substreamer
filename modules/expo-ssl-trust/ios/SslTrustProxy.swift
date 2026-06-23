import Foundation
import Network

/// Loopback-only HTTP reverse proxy that lets the app reach a self-signed
/// HTTPS server on iOS, where there is no system-wide trust hook (RN's
/// NSURLSession ignores `URLProtocol.registerClass`, and AVQueuePlayer
/// consults no URLSession config). The app talks plaintext HTTP to
/// 127.0.0.1; this proxy performs the single pinned HTTPS handshake to the
/// real server via `SslTrustStore.checkTrust`.
///
/// Design (see plan ios-self-signed-cert-proxy):
///  - Binds 127.0.0.1 ONLY, on a random high port (read back after bind).
///  - Each registered upstream base URL gets a random `token` that is both the
///    routing key AND a per-session access secret — an unknown token is
///    rejected (403), so another app on the device can't use us as an open
///    proxy. We only ever forward to registered upstreams.
///  - Transparent relay: forwards the incoming method (GET/POST/HEAD), body,
///    and `Range` header unchanged, and streams the upstream status + headers +
///    body straight back — so AVPlayer's `Range: bytes=0-1` → 206 probe and
///    OpenSubsonic form-POST both work untouched.
///  - `Connection: close` per request (no keep-alive) for predictability.
///  - Upstream connect/TLS/timeout failures relay as 502/504 so the app's
///    reachability monitoring still reflects the real server.
final class SslTrustProxy: NSObject {
    static let shared = SslTrustProxy()

    private let stateLock = NSLock()
    private var listener: NWListener?
    private var boundPort: UInt16 = 0
    /// token -> normalized upstream base URL (e.g. "https://music.example.com:4533").
    /// Tokens are stable for the life of the process so the JS-side cache stays
    /// valid across background-suspend/foreground restarts (only the port may
    /// change, and JS refreshes that on foreground).
    private var upstreamsByToken: [String: String] = [:]

    /// Pinned-trust delegate for the upstream HTTPS connection. Passed as the
    /// PER-TASK delegate to `bytes(for:delegate:)` (see `forward`). The async
    /// bytes/data APIs deliver the server-trust challenge to the TASK delegate's
    /// `urlSession(_:task:didReceive:)`, NOT to a session-level delegate — so a
    /// session-level trust handler is silently skipped, default validation runs,
    /// and the self-signed cert is rejected with -1202. The session itself has
    /// no delegate; trust is handled entirely per-task.
    private let trustDelegate = ProxyTrustDelegate()

    /// Upstream URLSession. Ephemeral so nothing is cached; one shared session
    /// handles concurrent upstream requests. Trust is handled per-task.
    private lazy var session: URLSession = {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        cfg.urlCache = nil
        // `timeoutIntervalForRequest` is an inactivity timer (reset on each byte
        // received). During streaming, AVPlayer buffers ahead and stops reading
        // the loopback socket — backpressure stalls our upstream read, so the
        // upstream connection sits idle while the buffered audio plays. The 60s
        // default then kills the connection mid-track. Raise it well past a
        // normal buffer-ahead idle; RNTP buffer-monitoring + app stall-recovery
        // remain the real dead-stream detectors. `timeoutIntervalForResource`
        // keeps its 7-day default as the overall backstop.
        cfg.timeoutIntervalForRequest = 300
        return URLSession(configuration: cfg)
    }()

    private let connQueue = DispatchQueue(label: "expo.ssltrust.proxy.conn", attributes: .concurrent)

    // MARK: - Public API (called from ExpoSslTrustModule on the JS thread)

    /// Register `baseUrl` as a forwardable upstream and return its token,
    /// starting the listener if needed. Idempotent — an already-registered base
    /// returns its existing token.
    func register(baseUrl: String) -> String {
        let normalized = Self.normalizeBase(baseUrl)
        return stateLock.withLock {
            if let existing = upstreamsByToken.first(where: { $0.value == normalized })?.key {
                return existing
            }
            let token = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
            upstreamsByToken[token] = normalized
            SslTrustLogger.log("registered upstream \(normalized)")
            return token
        }
    }

    /// Drop every registered upstream not present in `keep` (normalized base
    /// URLs). Used so logout / removed servers stop being forwardable.
    func retainOnly(_ keep: [String]) {
        let keepSet = Set(keep.map { Self.normalizeBase($0) })
        stateLock.withLock {
            upstreamsByToken = upstreamsByToken.filter { keepSet.contains($0.value) }
        }
    }

    /// True when at least one upstream is registered.
    private var hasUpstreams: Bool {
        stateLock.withLock { !upstreamsByToken.isEmpty }
    }

    /// Current proxy info for the JS cache: the live bound port and the
    /// token↔baseUrl pairs. Returns nil when nothing is registered.
    func info() -> [String: Any]? {
        stateLock.withLock {
            guard !upstreamsByToken.isEmpty, boundPort != 0 else { return nil }
            let pairs = upstreamsByToken.map { ["token": $0.key, "baseUrl": $0.value] }
            return ["port": Int(boundPort), "upstreams": pairs]
        }
    }

    /// Ensure the listener is bound. Safe to call repeatedly (foreground
    /// restart after a background suspend drops the socket). No-op when no
    /// upstreams are registered.
    func ensureRunning() {
        guard hasUpstreams else { return }
        // NB: the `return` must propagate out of `ensureRunning`, not just the
        // closure — otherwise start() runs even when already bound, spawning a
        // duplicate listener on a NEW port (stale port → dead connection).
        let alreadyRunning: Bool = stateLock.withLock {
            if let l = listener, l.state == .ready || l.state == .setup {
                return true
            }
            listener?.cancel()
            listener = nil
            return false
        }
        if alreadyRunning { return }
        start()
    }

    /// Ensure running, then wait (bounded) for the listener to actually bind so
    /// `info()` has a port. Called from the JS-thread AsyncFunctions (off the
    /// main thread), so the short block is harmless. Returns the proxy info once
    /// bound, or nil on timeout / no upstreams.
    func ensureRunningAndWait(timeoutMs: Int = 2000) -> [String: Any]? {
        ensureRunning()
        var waited = 0
        while waited < timeoutMs {
            if let i = info() { return i }
            Thread.sleep(forTimeInterval: 0.02)
            waited += 20
        }
        let result = info()
        if result == nil {
            let (p, n) = stateLock.withLock { (self.boundPort, self.upstreamsByToken.count) }
            SslTrustLogger.log("ensureRunningAndWait nil after \(timeoutMs)ms (boundPort=\(p) upstreams=\(n))")
        }
        return result
    }

    /// Stop the listener and forget the bound port. Tokens are retained so a
    /// later `ensureRunning()` reuses them. Call `retainOnly([])` to also clear
    /// upstreams (logout).
    func stop() {
        stateLock.withLock {
            listener?.cancel()
            listener = nil
            boundPort = 0
        }
    }

    // MARK: - Listener

    private func start() {
        do {
            let params = NWParameters.tcp
            // Loopback only. Bind to the loopback interface (lo0 = 127.0.0.1/::1)
            // and let the OS pick a free high port. NB: a listener-level
            // `requiredLocalEndpoint` is the WRONG tool here — on iOS it makes the
            // listener complete the TCP handshake but then RESET the connection
            // before it reaches `.ready`, so no response is ever written (the
            // "accept then reset, zero bytes" bug). `requiredInterfaceType =
            // .loopback` binds loopback-only (LAN connections on en0 are rejected
            // at the interface, satisfying the 127.0.0.1-only requirement) and
            // lets accepted connections actually reach `.ready`.
            params.requiredInterfaceType = .loopback
            params.allowLocalEndpointReuse = true

            let l = try NWListener(using: params)
            l.stateUpdateHandler = { [weak self] state in
                guard let self = self else { return }
                switch state {
                case .ready:
                    if let p = l.port?.rawValue {
                        self.stateLock.withLock { self.boundPort = p }
                        SslTrustLogger.log("listening on 127.0.0.1:\(p)")
                    } else {
                        SslTrustLogger.log("listener ready but no port")
                    }
                case .failed(let error):
                    SslTrustLogger.log("listener failed: \(error)")
                    self.stateLock.withLock {
                        if self.listener === l { self.listener = nil; self.boundPort = 0 }
                    }
                case .cancelled:
                    self.stateLock.withLock {
                        if self.listener === l { self.listener = nil; self.boundPort = 0 }
                    }
                default:
                    break
                }
            }
            l.newConnectionHandler = { [weak self] conn in
                self?.handle(connection: conn)
            }
            stateLock.withLock { self.listener = l }
            l.start(queue: connQueue)
        } catch {
            SslTrustLogger.log("failed to start listener: \(error)")
        }
    }

    // MARK: - Per-connection handling

    private func handle(connection conn: NWConnection) {
        // Each connection gets its OWN serial queue: NWConnection delivers all of
        // its callbacks there, and serial ordering avoids the send/receive races
        // a shared concurrent queue introduced. We wait for `.ready` before doing
        // any I/O — issuing `receive`/`send` on a not-yet-ready connection that
        // then fails resets the socket with no response written.
        let q = DispatchQueue(label: "expo.ssltrust.proxy.conn.handler")
        // Holds this connection's in-flight upstream streaming task so a client
        // disconnect can cancel it promptly (stop pulling bytes AVPlayer has
        // abandoned) instead of waiting for the next write to fail.
        let taskBox = TaskBox()
        conn.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                self?.readRequest(conn, buffer: Data(), taskBox: taskBox)
            case .failed(let error):
                // AVPlayer routinely cancels range connections it no longer needs;
                // that arrives here as a reset and is expected, not an error.
                taskBox.cancel()
                if !Self.isBenignDisconnect(error) {
                    SslTrustLogger.log("connection failed: \(error)")
                }
                conn.cancel()
            case .cancelled:
                taskBox.cancel()
            default:
                break
            }
        }
        conn.start(queue: q)
    }

    /// Accumulate bytes until the end of the request headers (\r\n\r\n), then
    /// read any Content-Length body and forward. Bounded so a malicious client
    /// can't grow the header buffer unbounded.
    private func readRequest(_ conn: NWConnection, buffer: Data, taskBox: TaskBox) {
        if buffer.count > 64 * 1024 {
            self.fail(conn, status: 431, reason: "Request Header Fields Too Large")
            return
        }
        conn.receive(minimumIncompleteLength: 1, maximumLength: 16 * 1024) { [weak self] data, _, isComplete, error in
            guard let self = self else { return }
            if error != nil {
                // A receive error means the client went away — expected churn.
                conn.cancel()
                return
            }
            var buf = buffer
            if let data = data { buf.append(data) }

            guard let headerEnd = Self.range(of: Self.headerTerminator, in: buf) else {
                if isComplete {
                    conn.cancel()
                } else {
                    self.readRequest(conn, buffer: buf, taskBox: taskBox)
                }
                return
            }

            let headerData = buf.subdata(in: 0..<headerEnd.lowerBound)
            let bodyStart = headerEnd.upperBound
            guard let req = ParsedRequest(headerData: headerData) else {
                self.fail(conn, status: 400, reason: "Bad Request")
                return
            }

            let alreadyHaveBody = buf.subdata(in: bodyStart..<buf.count)
            if req.contentLength > alreadyHaveBody.count {
                self.readBody(conn, req: req, body: alreadyHaveBody, taskBox: taskBox)
            } else {
                self.forward(conn, req: req, body: alreadyHaveBody.prefix(req.contentLength), taskBox: taskBox)
            }
        }
    }

    private func readBody(_ conn: NWConnection, req: ParsedRequest, body: Data, taskBox: TaskBox) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
            guard let self = self else { return }
            if error != nil {
                conn.cancel()
                return
            }
            var b = body
            if let data = data { b.append(data) }
            if b.count >= req.contentLength {
                self.forward(conn, req: req, body: b.prefix(req.contentLength), taskBox: taskBox)
            } else if isComplete {
                // Client closed early; forward what we have.
                self.forward(conn, req: req, body: b, taskBox: taskBox)
            } else {
                self.readBody(conn, req: req, body: b, taskBox: taskBox)
            }
        }
    }

    // MARK: - Forwarding

    private func forward(_ conn: NWConnection, req: ParsedRequest, body: Data, taskBox: TaskBox) {
        // Resolve token → upstream base URL. Unknown token = access denied.
        guard let baseUrl = stateLock.withLock({ upstreamsByToken[req.token] }),
              let upstream = URL(string: baseUrl + req.upstreamPath) else {
            SslTrustLogger.log("denied request with unknown token: \(req.pathOnly)")
            self.fail(conn, status: 403, reason: "Forbidden")
            return
        }
        SslTrustLogger.log("forward \(req.method) \(req.pathOnly)")

        var request = URLRequest(url: upstream)
        request.httpMethod = req.method
        request.cachePolicy = .reloadIgnoringLocalCacheData
        // Relay headers that matter to the upstream (Range, content negotiation,
        // auth, user-agent, content-type for POST). Skip hop-by-hop + Host.
        for (name, value) in req.forwardableHeaders {
            request.setValue(value, forHTTPHeaderField: name)
        }
        if !body.isEmpty {
            request.httpBody = body
        }

        let task = Task { [weak self] in
            guard let self = self else { return }
            do {
                let (bytes, response) = try await self.session.bytes(for: request, delegate: self.trustDelegate)
                guard let http = response as? HTTPURLResponse else {
                    SslTrustLogger.log("upstream non-HTTP response \(req.pathOnly)")
                    self.fail(conn, status: 502, reason: "Bad Gateway")
                    return
                }
                SslTrustLogger.log("upstream \(http.statusCode) \(req.pathOnly)")
                // Write status line + relayed response headers.
                let head = Self.responseHead(from: http)
                try await self.send(conn, Data(head.utf8))
                // Stream the body straight through (no whole-file buffering).
                var chunk = Data()
                chunk.reserveCapacity(64 * 1024)
                for try await byte in bytes {
                    if Task.isCancelled { conn.cancel(); return }
                    chunk.append(byte)
                    if chunk.count >= 64 * 1024 {
                        try await self.send(conn, chunk)
                        chunk.removeAll(keepingCapacity: true)
                    }
                }
                if !chunk.isEmpty {
                    try await self.send(conn, chunk)
                }
                conn.cancel()
            } catch {
                // A client disconnect (AVPlayer cancelling a range request) or our
                // own cancellation surfaces here as a write/stream failure — that's
                // normal churn, not an upstream fault, so relay nothing.
                if Task.isCancelled || Self.isClientGone(error) {
                    conn.cancel()
                    return
                }
                // Distinguish timeout from other upstream failures for the app's
                // reachability monitoring. Log code+domain only — the NSError
                // description embeds the full URL incl. auth params.
                let status = (error as? URLError)?.code == .timedOut ? 504 : 502
                let ns = error as NSError
                SslTrustLogger.log("upstream error (\(status)) \(req.pathOnly): \(ns.domain) \(ns.code)")
                self.fail(conn, status: status, reason: "Upstream Error")
            }
        }
        taskBox.set(task)
    }

    // MARK: - Writing

    private func send(_ conn: NWConnection, _ data: Data) async throws {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            conn.send(content: data, completion: .contentProcessed { error in
                if let error = error { cont.resume(throwing: error) }
                else { cont.resume(returning: ()) }
            })
        }
    }

    private func fail(_ conn: NWConnection, status: Int, reason: String) {
        let body = "\(status) \(reason)"
        let head = "HTTP/1.1 \(status) \(reason)\r\n" +
            "Content-Type: text/plain; charset=utf-8\r\n" +
            "Content-Length: \(body.utf8.count)\r\n" +
            "Connection: close\r\n\r\n"
        conn.send(content: Data((head + body).utf8), completion: .contentProcessed { _ in
            conn.cancel()
        })
    }

    // MARK: - Helpers

    private static func responseHead(from http: HTTPURLResponse) -> String {
        var head = "HTTP/1.1 \(http.statusCode) \(HTTPURLResponse.localizedString(forStatusCode: http.statusCode))\r\n"
        // Relay response headers verbatim EXCEPT hop-by-hop / framing ones we
        // re-derive. We always close the connection per request.
        let drop: Set<String> = ["connection", "keep-alive", "transfer-encoding",
                                  "content-encoding"]
        for (key, value) in http.allHeaderFields {
            guard let name = key as? String, let val = value as? String else { continue }
            if drop.contains(name.lowercased()) { continue }
            head += "\(name): \(val)\r\n"
        }
        head += "Connection: close\r\n\r\n"
        return head
    }

    /// Normalize a base URL to scheme://host[:port] (lowercased, no trailing
    /// slash, no path) so registration/lookup is stable.
    static func normalizeBase(_ url: String) -> String {
        guard let c = URLComponents(string: url), let scheme = c.scheme, let host = c.host else {
            return url.lowercased()
        }
        var base = "\(scheme.lowercased())://\(host.lowercased())"
        if let port = c.port { base += ":\(port)" }
        return base
    }

    /// True for the connection-failure codes that mean the CLIENT hung up
    /// (AVPlayer cancelling a range request) rather than a real fault — so we
    /// stay quiet instead of logging it as an error.
    private static func isBenignDisconnect(_ error: NWError) -> Bool {
        if case .posix(let code) = error {
            return code == .ECONNRESET || code == .ENOTCONN || code == .EPIPE || code == .ECANCELED
        }
        return false
    }

    /// True when an upstream stream/write error is actually the local client
    /// connection going away mid-stream (relay nothing, just clean up).
    private static func isClientGone(_ error: Error) -> Bool {
        if let nw = error as? NWError {
            return isBenignDisconnect(nw)
        }
        let ns = error as NSError
        return ns.domain == NSPOSIXErrorDomain &&
            (ns.code == Int(ECONNRESET) || ns.code == Int(ENOTCONN) || ns.code == Int(EPIPE))
    }

    private static let headerTerminator = Data("\r\n\r\n".utf8)

    private static func range(of needle: Data, in haystack: Data) -> Range<Int>? {
        guard needle.count <= haystack.count else { return nil }
        let upper = haystack.count - needle.count
        var i = haystack.startIndex
        while i <= upper {
            if haystack[i..<(i + needle.count)].elementsEqual(needle) {
                return i..<(i + needle.count)
            }
            i += 1
        }
        return nil
    }
}

// MARK: - Per-connection task holder

/// Thread-safe holder for a connection's in-flight upstream streaming task, so a
/// client disconnect (handled on the connection queue) can cancel the streaming
/// task (running on a separate Task executor) promptly.
private final class TaskBox {
    private let lock = NSLock()
    private var task: Task<Void, Never>?
    func set(_ t: Task<Void, Never>) { lock.lock(); task = t; lock.unlock() }
    func cancel() { lock.lock(); task?.cancel(); task = nil; lock.unlock() }
}

// MARK: - Request parsing

/// A minimal parse of the incoming request: just what a transparent relay
/// needs. The path is `/<token>/<rest…>`; `upstreamPath` is `/<rest…>`.
private struct ParsedRequest {
    let method: String
    let token: String
    let upstreamPath: String
    let contentLength: Int
    let forwardableHeaders: [(String, String)]

    /// The path with any query string stripped — safe to log. The query carries
    /// the Subsonic auth params (`t`/`s`) that must never reach the shareable
    /// diagnostic log.
    var pathOnly: String {
        if let q = upstreamPath.firstIndex(of: "?") {
            return String(upstreamPath[upstreamPath.startIndex..<q])
        }
        return upstreamPath
    }

    init?(headerData: Data) {
        guard let text = String(data: headerData, encoding: .utf8) else { return nil }
        var lines = text.components(separatedBy: "\r\n")
        guard !lines.isEmpty else { return nil }
        let requestLine = lines.removeFirst().split(separator: " ")
        guard requestLine.count >= 2 else { return nil }
        self.method = String(requestLine[0]).uppercased()

        // requestLine[1] = "/<token>/rest/stream.view?..."
        let target = String(requestLine[1])
        guard target.hasPrefix("/") else { return nil }
        let afterSlash = target.dropFirst()
        guard let firstSlash = afterSlash.firstIndex(of: "/") else {
            // "/<token>" with no further path → root request to upstream.
            self.token = String(afterSlash)
            self.upstreamPath = "/"
            self.contentLength = 0
            self.forwardableHeaders = []
            return
        }
        self.token = String(afterSlash[afterSlash.startIndex..<firstSlash])
        self.upstreamPath = String(afterSlash[firstSlash...])

        var length = 0
        var headers: [(String, String)] = []
        // Hop-by-hop + routing headers we never forward. Host is re-derived by
        // URLSession from the upstream URL.
        let drop: Set<String> = ["host", "connection", "keep-alive", "proxy-connection",
                                 "transfer-encoding", "upgrade", "content-length"]
        for line in lines where !line.isEmpty {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let name = String(line[line.startIndex..<colon]).trimmingCharacters(in: .whitespaces)
            let value = String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
            let lower = name.lowercased()
            if lower == "content-length" { length = Int(value) ?? 0 }
            if drop.contains(lower) { continue }
            headers.append((name, value))
        }
        self.contentLength = length
        self.forwardableHeaders = headers
    }
}

// MARK: - Upstream pinned-trust delegate

/// Reuses the app's existing pinned trust decision (`SslTrustStore.checkTrust`)
/// for the proxy's single upstream HTTPS connection. Identical logic to the
/// (now-removed) SslTrustURLProtocol challenge handler — only the delivery
/// mechanism changed.
private final class ProxyTrustDelegate: NSObject, URLSessionTaskDelegate {
    // TASK-level challenge: this is the one the async `bytes(for:delegate:)` API
    // invokes for its per-task delegate. (A session-level `urlSession(_:didReceive:)`
    // is NOT consulted by that API — which is why the self-signed cert was being
    // rejected with -1202 before.)
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let serverTrust = challenge.protectionSpace.serverTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        let host = challenge.protectionSpace.host

        // System trust first (covers a host that also has a valid CA chain).
        var error: CFError?
        if SecTrustEvaluateWithError(serverTrust, &error) {
            completionHandler(.performDefaultHandling, nil)
            return
        }

        // System rejected → fall back to the user-accepted pinned cert.
        if SslTrustStore.shared.checkTrust(hostname: host, serverTrust: serverTrust) {
            completionHandler(.useCredential, URLCredential(trust: serverTrust))
        } else {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }
}

private extension NSLock {
    @discardableResult
    func withLock<T>(_ body: () -> T) -> T {
        lock(); defer { unlock() }
        return body()
    }
}
