package expo.modules.ssltrust

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class ExpoSslTrustModule : Module() {
    override fun definition() = ModuleDefinition {
        Name("ExpoSslTrust")

        AsyncFunction("initTrustStore") { promise: Promise ->
            try {
                val context = appContext.reactContext ?: throw Exception("React context not available")
                SslTrustStore.init(context)
                // SslTrustStore.init() catches its own JSSE failures and records them
                // on installSucceeded / lastInstallError. The JS layer queries
                // getInstallStatus() to surface failures to the user.
                promise.resolve(
                    mapOf(
                        "installed" to SslTrustStore.installSucceeded,
                        "error" to SslTrustStore.lastInstallError,
                    )
                )
            } catch (e: Exception) {
                promise.reject("ERR_INIT_TRUST_STORE", e.message, e)
            }
        }

        AsyncFunction("getInstallStatus") { promise: Promise ->
            promise.resolve(
                mapOf(
                    "installed" to SslTrustStore.installSucceeded,
                    "error" to SslTrustStore.lastInstallError,
                )
            )
        }

        AsyncFunction("getCertificateInfo") { url: String, promise: Promise ->
            CoroutineScope(Dispatchers.IO).launch {
                try {
                    val info = CertificateInspector.getCertificateInfo(url)
                    
                    // Store the DER data temporarily so it's available
                    // when the user trusts the certificate
                    if (info.derData != null) {
                        try {
                            val parsedUrl = java.net.URL(
                                if (url.startsWith("http")) url else "https://$url"
                            )
                            SslTrustStore.storeCertDerData(parsedUrl.host, info.derData)
                        } catch (_: Exception) { }
                    }
                    
                    val result = mapOf(
                        "subject" to info.subject,
                        "issuer" to info.issuer,
                        "sha256Fingerprint" to info.sha256Fingerprint,
                        "validFrom" to info.validFrom,
                        "validTo" to info.validTo,
                        "serialNumber" to info.serialNumber,
                        "isSelfSigned" to info.isSelfSigned,
                        "isSystemTrusted" to info.isSystemTrusted
                    )
                    promise.resolve(result)
                } catch (e: Exception) {
                    promise.reject("ERR_CERT_FETCH", "Failed to fetch certificate: ${e.message}", e)
                }
            }
        }

        AsyncFunction("trustCertificate") { hostname: String, sha256Fingerprint: String, validTo: String?, promise: Promise ->
            try {
                val context = appContext.reactContext ?: throw Exception("React context not available")
                SslTrustStore.init(context) // trusting needs the trust-manager install
                SslTrustStore.trustCertificate(hostname, sha256Fingerprint, validTo)
                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("ERR_TRUST_CERT", e.message, e)
            }
        }

        AsyncFunction("removeTrustedCertificate") { hostname: String, promise: Promise ->
            try {
                val context = appContext.reactContext ?: throw Exception("React context not available")
                // loadCerts (not init): removeTrustedCertificate re-installs the
                // trust manager itself with the updated store.
                SslTrustStore.loadCerts(context)
                SslTrustStore.removeTrustedCertificate(hostname)
                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("ERR_REMOVE_CERT", e.message, e)
            }
        }

        AsyncFunction("clearAllTrustedCertificates") { promise: Promise ->
            try {
                val context = appContext.reactContext ?: throw Exception("React context not available")
                SslTrustStore.loadCerts(context)
                SslTrustStore.clearAllTrustedCertificates()
                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("ERR_CLEAR_CERTS", e.message, e)
            }
        }

        // Read-only: `loadCerts` (no install). The OkHttp factory is installed at
        // app startup by ExpoSslTrustPackage's ApplicationLifecycleListener (which
        // is the only point early enough — before RN builds its fixed HTTP client),
        // so reads don't need to install.
        AsyncFunction("getTrustedCertificates") { promise: Promise ->
            try {
                val context = appContext.reactContext ?: throw Exception("React context not available")
                SslTrustStore.loadCerts(context)
                val certs = SslTrustStore.getTrustedCertificates()
                promise.resolve(certs)
            } catch (e: Exception) {
                promise.reject("ERR_GET_CERTS", e.message, e)
            }
        }

        AsyncFunction("isCertificateTrusted") { hostname: String, promise: Promise ->
            try {
                val context = appContext.reactContext ?: throw Exception("React context not available")
                // loadCerts only: not called from JS in a path that needs install
                // (the native hostname verifier reads the store directly).
                SslTrustStore.loadCerts(context)
                val trusted = SslTrustStore.isCertificateTrusted(hostname)
                promise.resolve(trusted)
            } catch (e: Exception) {
                promise.reject("ERR_CHECK_CERT", e.message, e)
            }
        }
    }
}
