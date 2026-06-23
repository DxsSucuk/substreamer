package expo.modules.ssltrust

import java.net.URL
import java.security.MessageDigest
import java.security.cert.X509Certificate
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

/**
 * Fetches SSL certificate information from a remote server by opening
 * a raw TLS connection that accepts any certificate (for inspection only).
 */
object CertificateInspector {

    data class CertInfo(
        val subject: String,
        val issuer: String,
        val sha256Fingerprint: String,
        val validFrom: String,
        val validTo: String,
        val serialNumber: String,
        val isSelfSigned: Boolean,
        /** Whether the device's default trust store already accepts this endpoint
         *  (full chain + hostname + validity). True means the OS trusts it, so the
         *  app must NOT pin it — pinning a system-trusted cert is pointless and
         *  routes streaming through expo-ssl-trust for zero benefit. Mirrors iOS's
         *  SecTrustEvaluateWithError verdict so both platforms behave identically. */
        val isSystemTrusted: Boolean,
        val derData: ByteArray? = null
    )

    /**
     * Connect to the given URL and extract the server's leaf certificate info.
     * Uses a trust-all TrustManager solely for the purpose of reading the cert;
     * this does NOT affect any other connections in the app.
     */
    fun getCertificateInfo(urlString: String): CertInfo {
        val url = normalizeUrl(urlString)
        val host = url.host
        val port = if (url.port != -1) url.port else 443

        // Create a trust-all manager just for inspection
        val trustAllManager = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {}
            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {}
            override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
        }

        val sslContext = SSLContext.getInstance("TLS")
        sslContext.init(null, arrayOf<TrustManager>(trustAllManager), java.security.SecureRandom())

        val connection = url.openConnection() as? HttpsURLConnection
            ?: throw Exception("Not an HTTPS URL: ${url.protocol}")
        connection.sslSocketFactory = sslContext.socketFactory
        connection.hostnameVerifier = javax.net.ssl.HostnameVerifier { _, _ -> true }
        connection.connectTimeout = 10_000
        connection.readTimeout = 10_000
        connection.requestMethod = "HEAD"

        try {
            connection.connect()
            val certs = connection.serverCertificates
            if (certs.isEmpty()) {
                throw Exception("No certificates returned by server")
            }

            val leaf = certs[0] as? X509Certificate
                ?: throw Exception("Server leaf certificate is not X.509")
            return extractCertInfo(leaf, evaluateSystemTrust(url))
        } finally {
            connection.disconnect()
        }
    }

    /**
     * Does the device's default trust store accept this endpoint? Opens a second
     * connection using the system defaults (no trust-all override, default
     * hostname verifier) and reports whether the TLS handshake succeeds. The
     * inspection connection above already proved connectivity, so a failure here
     * is a genuine trust/hostname/expiry rejection, not an outage. A deliberate
     * one-off cost on settings/login actions — not a hot path.
     */
    private fun evaluateSystemTrust(url: URL): Boolean {
        var conn: HttpsURLConnection? = null
        return try {
            conn = url.openConnection() as? HttpsURLConnection ?: return false
            conn.connectTimeout = 10_000
            conn.readTimeout = 10_000
            conn.requestMethod = "HEAD"
            conn.connect() // throws if the system trust manager / hostname verifier rejects
            true
        } catch (_: Exception) {
            false
        } finally {
            conn?.disconnect()
        }
    }

    private fun extractCertInfo(cert: X509Certificate, isSystemTrusted: Boolean): CertInfo {
        val isoFormat = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US)
        isoFormat.timeZone = TimeZone.getTimeZone("UTC")

        val subject = cert.subjectX500Principal.name
        val issuer = cert.issuerX500Principal.name
        val isSelfSigned = subject == issuer

        val digest = MessageDigest.getInstance("SHA-256")
        val hash = digest.digest(cert.encoded)
        val fingerprint = hash.joinToString(":") { "%02X".format(it) }

        return CertInfo(
            subject = subject,
            issuer = issuer,
            sha256Fingerprint = fingerprint,
            validFrom = isoFormat.format(cert.notBefore),
            validTo = isoFormat.format(cert.notAfter),
            serialNumber = cert.serialNumber.toString(16).uppercase(),
            isSelfSigned = isSelfSigned,
            isSystemTrusted = isSystemTrusted,
            derData = cert.encoded
        )
    }

    private fun normalizeUrl(urlString: String): URL {
        var normalized = urlString.trim()
        if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) {
            normalized = "https://$normalized"
        }
        return URL(normalized)
    }
}
