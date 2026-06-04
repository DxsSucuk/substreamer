import ExpoModulesCore
import Foundation
import Security

public class ExpoSslTrustModule: Module {
    public func definition() -> ModuleDefinition {
        Name("ExpoSslTrust")
        
        AsyncFunction("initTrustStore") { (promise: Promise) in
            SslTrustStore.shared.initialize()
            // Resolve the install status to match the Android contract
            // (`{ installed, error }`). iOS has no JSSE-style install failure,
            // so `error` is always null once initialize() has run.
            promise.resolve([
                "installed": SslTrustStore.shared.installSucceeded,
                "error": NSNull(),
            ])
        }

        AsyncFunction("getInstallStatus") { (promise: Promise) in
            promise.resolve([
                "installed": SslTrustStore.shared.installSucceeded,
                "error": NSNull(),
            ])
        }

        AsyncFunction("getCertificateInfo") { (url: String, promise: Promise) in
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    let info = try CertificateInspector.getCertificateInfo(urlString: url)
                    
                    // Store the DER data temporarily keyed by hostname
                    // so it's available when the user trusts the certificate
                    if let derData = info.derData,
                       let urlObj = URL(string: url),
                       let host = urlObj.host {
                        SslTrustStore.shared.storeCertificateData(hostname: host, derData: derData)
                    }
                    
                    let result: [String: Any] = [
                        "subject": info.subject,
                        "issuer": info.issuer,
                        "sha256Fingerprint": info.sha256Fingerprint,
                        "validFrom": info.validFrom,
                        "validTo": info.validTo,
                        "serialNumber": info.serialNumber,
                        "isSelfSigned": info.isSelfSigned
                    ]
                    promise.resolve(result)
                } catch {
                    promise.reject("ERR_CERT_FETCH", "Failed to fetch certificate: \(error.localizedDescription)")
                }
            }
        }
        
        AsyncFunction("trustCertificate") { (hostname: String, sha256Fingerprint: String, promise: Promise) in
            SslTrustStore.shared.initialize()
            SslTrustStore.shared.trustCertificate(hostname: hostname, sha256Fingerprint: sha256Fingerprint)
            promise.resolve(nil)
        }
        
        AsyncFunction("removeTrustedCertificate") { (hostname: String, promise: Promise) in
            SslTrustStore.shared.initialize()
            SslTrustStore.shared.removeTrustedCertificate(hostname: hostname)
            promise.resolve(nil)
        }
        
        AsyncFunction("getTrustedCertificates") { (promise: Promise) in
            SslTrustStore.shared.initialize()
            let certs = SslTrustStore.shared.getTrustedCertificates()
            promise.resolve(certs)
        }
        
        AsyncFunction("isCertificateTrusted") { (hostname: String, promise: Promise) in
            SslTrustStore.shared.initialize()
            let trusted = SslTrustStore.shared.isCertificateTrusted(hostname: hostname)
            promise.resolve(trusted)
        }
    }
}
