import Foundation
import Security
import CommonCrypto

/// Manages the persisted store of trusted self-signed certificate fingerprints.
/// Backed by UserDefaults for fast native-level access before the JS bridge loads.
class SslTrustStore: NSObject {
    static let shared = SslTrustStore()
    
    private let userDefaultsKey = "expo_ssl_trust_store"
    private var trustedCerts: [String: TrustedCertEntry] = [:]
    private var isInitialized = false

    /// Serializes all access to the in-memory trust maps (`trustedCerts` and
    /// `certDataStore`). They are READ on TLS-handshake threads (`checkTrust` /
    /// `isCertificateTrusted` / `isFingerprintMismatch`, reached from the
    /// URLProtocol's auth-challenge delegate) and WRITTEN from the JS-thread
    /// module functions (`trustCertificate` / `storeCertificateData` / `load`).
    /// Concurrent Swift Dictionary access is otherwise undefined behaviour (a
    /// crash). Critical sections only touch the maps — UserDefaults and Keychain
    /// I/O happen OUTSIDE the lock via snapshots, so a handshake-thread read is
    /// never blocked behind disk/keychain work.
    private let storeLock = NSLock()

    private func withStoreLock<T>(_ body: () -> T) -> T {
        storeLock.lock()
        defer { storeLock.unlock() }
        return body()
    }

    /// Whether the trust store has been installed. On iOS, registering the
    /// URLProtocol has no JSSE-style failure mode (unlike Android), so this is
    /// simply true once `initialize()` has run. Exposed so the module's
    /// `initTrustStore`/`getInstallStatus` can report a status matching the
    /// Android contract (`{ installed, error }`).
    var installSucceeded: Bool { isInitialized }

    struct TrustedCertEntry: Codable {
        let sha256Fingerprint: String
        let acceptedAt: Double // epoch ms
    }
    
    // MARK: - Initialization
    
    func initialize() {
        guard !isInitialized else { return }
        load()
        isInitialized = true
    }
    
    private func load() {
        guard let data = UserDefaults.standard.data(forKey: userDefaultsKey) else { return }
        let decoded = (try? JSONDecoder().decode([String: TrustedCertEntry].self, from: data)) ?? [:]
        withStoreLock { trustedCerts = decoded }
    }

    private func save() {
        // Snapshot under the lock, then encode/write to UserDefaults outside it.
        let snapshot = withStoreLock { trustedCerts }
        do {
            let data = try JSONEncoder().encode(snapshot)
            UserDefaults.standard.set(data, forKey: userDefaultsKey)
        } catch {
            print("[SslTrustStore] Failed to save: \(error)")
        }
    }
    
    // MARK: - Trust Management
    
    func trustCertificate(hostname: String, sha256Fingerprint: String) {
        let entry = TrustedCertEntry(
            sha256Fingerprint: sha256Fingerprint.uppercased(),
            acceptedAt: Double(Date().timeIntervalSince1970 * 1000)
        )
        // Write the map entry and read back any stored DER in one critical section.
        let derData: Data? = withStoreLock {
            trustedCerts[hostname] = entry
            return certDataStore[hostname]
        }
        save()
        // Also add to Keychain for AVPlayer using stored DER data if available.
        if let derData = derData {
            addCertToKeychain(hostname: hostname, certData: derData)
        } else {
            addFingerprintToKeychain(hostname: hostname)
        }
    }

    func removeTrustedCertificate(hostname: String) {
        withStoreLock { _ = trustedCerts.removeValue(forKey: hostname) }
        save()
        removeCertFromKeychain(hostname: hostname)
    }

    func getTrustedCertificates() -> [[String: Any]] {
        let snapshot = withStoreLock { trustedCerts }
        return snapshot.map { (hostname, entry) in
            [
                "hostname": hostname,
                "sha256Fingerprint": entry.sha256Fingerprint,
                "acceptedAt": entry.acceptedAt
            ]
        }
    }

    func isCertificateTrusted(hostname: String) -> Bool {
        return withStoreLock { trustedCerts[hostname] != nil }
    }
    
    /// Check if a server trust is valid against our custom store.
    /// Returns true if trusted, false if not in store, throws on fingerprint mismatch.
    /// Extract the leaf certificate from a SecTrust object.
    private static func leafCertificate(from serverTrust: SecTrust) -> SecCertificate? {
        if let chain = SecTrustCopyCertificateChain(serverTrust) as? [SecCertificate],
           let leaf = chain.first {
            return leaf
        }
        return nil
    }
    
    func checkTrust(hostname: String, serverTrust: SecTrust) -> Bool {
        guard let entry = withStoreLock({ trustedCerts[hostname] }) else { return false }

        guard let certificate = SslTrustStore.leafCertificate(from: serverTrust) else {
            return false
        }
        
        let fingerprint = SslTrustStore.sha256Fingerprint(of: certificate)
        if fingerprint.caseInsensitiveCompare(entry.sha256Fingerprint) == .orderedSame {
            return true
        }
        
        // Hostname is known but fingerprint changed
        return false
    }
    
    func isFingerprintMismatch(hostname: String, serverTrust: SecTrust) -> Bool {
        guard let entry = withStoreLock({ trustedCerts[hostname] }) else { return false }
        guard let certificate = SslTrustStore.leafCertificate(from: serverTrust) else {
            return false
        }
        let fingerprint = SslTrustStore.sha256Fingerprint(of: certificate)
        return fingerprint.caseInsensitiveCompare(entry.sha256Fingerprint) != .orderedSame
    }
    
    // MARK: - Certificate Fingerprint
    
    static func sha256Fingerprint(of certificate: SecCertificate) -> String {
        let data = SecCertificateCopyData(certificate) as Data
        var hash = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
        data.withUnsafeBytes { bytes in
            _ = CC_SHA256(bytes.baseAddress, CC_LONG(data.count), &hash)
        }
        return hash.map { String(format: "%02X", $0) }.joined(separator: ":")
    }
    
    // MARK: - Certificate DER Data Storage (for AVPlayer)
    
    /// Store the actual certificate DER data for a hostname.
    /// This is used to add the certificate as a trust anchor in the Keychain,
    /// which AVPlayer and other system components can recognize.
    private var certDataStore: [String: Data] = [:]
    
    func storeCertificateData(hostname: String, derData: Data) {
        withStoreLock { certDataStore[hostname] = derData }
        addCertToKeychain(hostname: hostname, certData: derData)
    }

    func getCertificateData(hostname: String) -> Data? {
        return withStoreLock { certDataStore[hostname] }
    }
    
    // MARK: - Keychain Management (for AVPlayer)
    
    private func addCertToKeychain(hostname: String, certData: Data) {
        let tag = "expo.ssl.trust.\(hostname)"
        
        // Remove existing entry first
        let deleteQuery: [String: Any] = [
            kSecClass as String: kSecClassCertificate,
            kSecAttrLabel as String: tag
        ]
        SecItemDelete(deleteQuery as CFDictionary)
        
        // Add the certificate to the Keychain
        guard let certificate = SecCertificateCreateWithData(nil, certData as CFData) else {
            // Fall back to storing the fingerprint as a generic password
            addFingerprintToKeychain(hostname: hostname)
            return
        }
        
        let addQuery: [String: Any] = [
            kSecClass as String: kSecClassCertificate,
            kSecValueRef as String: certificate,
            kSecAttrLabel as String: tag,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock
        ]
        
        let status = SecItemAdd(addQuery as CFDictionary, nil)
        if status != errSecSuccess && status != errSecDuplicateItem {
            print("[SslTrustStore] Failed to add cert to Keychain: \(status)")
            addFingerprintToKeychain(hostname: hostname)
        }
    }
    
    /// Fallback: store just the fingerprint as a generic password
    private func addFingerprintToKeychain(hostname: String) {
        guard let entry = withStoreLock({ trustedCerts[hostname] }) else { return }
        let tag = "expo.ssl.trust.fp.\(hostname)"
        // U6 hygiene: fingerprint is hex ASCII so UTF-8 encoding can't fail in
        // practice, but the force-unwrap is still removed defensively.
        guard let data = entry.sha256Fingerprint.data(using: .utf8) else { return }
        
        let deleteQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: tag,
            kSecAttrService as String: "expo-ssl-trust"
        ]
        SecItemDelete(deleteQuery as CFDictionary)
        
        let addQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: tag,
            kSecAttrService as String: "expo-ssl-trust",
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock
        ]
        SecItemAdd(addQuery as CFDictionary, nil)
    }
    
    private func removeCertFromKeychain(hostname: String) {
        // Remove certificate entry
        let certTag = "expo.ssl.trust.\(hostname)"
        let certQuery: [String: Any] = [
            kSecClass as String: kSecClassCertificate,
            kSecAttrLabel as String: certTag
        ]
        SecItemDelete(certQuery as CFDictionary)
        
        // Remove fingerprint fallback entry
        let fpTag = "expo.ssl.trust.fp.\(hostname)"
        let fpQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: fpTag,
            kSecAttrService as String: "expo-ssl-trust"
        ]
        SecItemDelete(fpQuery as CFDictionary)
    }
}
