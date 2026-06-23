import Foundation
import Security
import CommonCrypto

/// Fetches SSL certificate information from a remote server by opening
/// a URLSession that captures the certificate without normal trust validation.
class CertificateInspector: NSObject, URLSessionDelegate {
    
    struct CertInfo {
        let subject: String
        let issuer: String
        let sha256Fingerprint: String
        let validFrom: String
        let validTo: String
        let serialNumber: String
        let isSelfSigned: Bool
        /// The device's OWN verdict on this cert (chain + hostname + dates). True
        /// means iOS already trusts it, so the app should NOT pin it — pinning a
        /// system-trusted cert needlessly forces streaming onto the loopback proxy.
        let isSystemTrusted: Bool
        let derData: Data?
    }
    
    private var capturedCertificate: SecCertificate?
    private var capturedTrust: SecTrust?
    private var capturedSystemTrusted = false
    private let semaphore = DispatchSemaphore(value: 0)
    private var connectionError: Error?
    
    /// Connect to the given URL and extract the server's leaf certificate info.
    /// Uses a trust-all delegate solely for reading the cert.
    static func getCertificateInfo(urlString: String) throws -> CertInfo {
        let inspector = CertificateInspector()
        return try inspector.fetchCertificate(urlString: urlString)
    }
    
    private func fetchCertificate(urlString: String) throws -> CertInfo {
        let normalized = normalizeUrl(urlString)
        guard let url = URL(string: normalized) else {
            throw NSError(domain: "CertificateInspector", code: -1,
                         userInfo: [NSLocalizedDescriptionKey: "Invalid URL: \(urlString)"])
        }
        
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 10
        config.timeoutIntervalForResource = 10
        
        let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        
        var request = URLRequest(url: url)
        request.httpMethod = "HEAD"
        
        let task = session.dataTask(with: request) { [weak self] _, _, error in
            self?.connectionError = error
            self?.semaphore.signal()
        }
        task.resume()
        
        let result = semaphore.wait(timeout: .now() + 15)
        session.invalidateAndCancel()
        
        if result == .timedOut {
            throw NSError(domain: "CertificateInspector", code: -2,
                         userInfo: [NSLocalizedDescriptionKey: "Connection timed out"])
        }
        
        guard let certificate = capturedCertificate else {
            if let error = connectionError {
                throw error
            }
            throw NSError(domain: "CertificateInspector", code: -3,
                         userInfo: [NSLocalizedDescriptionKey: "No certificate received from server"])
        }
        
        return extractCertInfo(certificate: certificate, isSystemTrusted: capturedSystemTrusted)
    }
    
    // MARK: - URLSessionDelegate
    
    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let serverTrust = challenge.protectionSpace.serverTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        
        // Capture the certificate for inspection
        if let chain = SecTrustCopyCertificateChain(serverTrust) as? [SecCertificate],
           let cert = chain.first {
            capturedCertificate = cert
            capturedTrust = serverTrust
        }

        // Record the device's own verdict (same trust, evaluated against its SSL
        // policy) BEFORE we override it below — so JS can avoid pinning a cert iOS
        // already trusts. This is a read; the .useCredential override still lets us
        // capture self-signed / otherwise-untrusted certs for the prompt.
        var sysErr: CFError?
        capturedSystemTrusted = SecTrustEvaluateWithError(serverTrust, &sysErr)

        // Accept the certificate (we're only inspecting)
        let credential = URLCredential(trust: serverTrust)
        completionHandler(.useCredential, credential)
    }
    
    // MARK: - Certificate Extraction
    
    private func extractCertInfo(certificate: SecCertificate, isSystemTrusted: Bool) -> CertInfo {
        let fingerprint = SslTrustStore.sha256Fingerprint(of: certificate)
        let derData = SecCertificateCopyData(certificate) as Data
        
        // On iOS, we use SecCertificateCopySubjectSummary for subject and
        // parse the DER data for additional info. The full X.509 parsing
        // is limited on iOS compared to macOS.
        let subjectSummary = SecCertificateCopySubjectSummary(certificate) as String? ?? "Unknown"
        let subject = "CN=\(subjectSummary)"
        
        // Parse issuer and other fields from the DER-encoded certificate
        let parsedFields = parseDERCertificate(derData)
        let issuer = parsedFields.issuer ?? subject
        let isSelfSigned = (subject == issuer)
        
        return CertInfo(
            subject: subject,
            issuer: issuer,
            sha256Fingerprint: fingerprint,
            validFrom: parsedFields.validFrom ?? "Unknown",
            validTo: parsedFields.validTo ?? "Unknown",
            serialNumber: parsedFields.serialNumber ?? "Unknown",
            isSelfSigned: isSelfSigned,
            isSystemTrusted: isSystemTrusted,
            derData: derData
        )
    }
    
    // MARK: - DER Parsing Helpers
    
    struct ParsedCertFields {
        var issuer: String?
        var validFrom: String?
        var validTo: String?
        var serialNumber: String?
    }
    
    /// Minimal DER/ASN.1 parsing to extract issuer, validity dates, and serial number.
    /// iOS doesn't expose SecCertificateCopyValues, so we parse the raw DER data.
    private func parseDERCertificate(_ data: Data) -> ParsedCertFields {
        var result = ParsedCertFields()
        let bytes = [UInt8](data)
        
        guard bytes.count > 4 else { return result }
        
        // A X.509 certificate is a SEQUENCE containing a TBSCertificate SEQUENCE
        // TBSCertificate contains: version, serialNumber, signature, issuer, validity, subject, ...
        
        var offset = 0
        
        // Outer SEQUENCE
        guard let outerSeq = readASN1Sequence(bytes: bytes, offset: &offset) else { return result }
        
        // TBSCertificate SEQUENCE
        var tbsOffset = outerSeq.contentOffset
        guard let tbsSeq = readASN1Sequence(bytes: bytes, offset: &tbsOffset) else { return result }
        
        var pos = tbsSeq.contentOffset
        let tbsEnd = tbsSeq.contentOffset + tbsSeq.contentLength
        
        // Version (optional, context tag [0])
        if pos < tbsEnd && bytes[pos] == 0xA0 {
            var versionOffset = pos
            _ = skipASN1Element(bytes: bytes, offset: &versionOffset)
            pos = versionOffset
        }
        
        // Serial Number (INTEGER)
        if pos < tbsEnd {
            result.serialNumber = readASN1Integer(bytes: bytes, offset: &pos)
        }
        
        // Signature Algorithm (skip)
        if pos < tbsEnd {
            _ = skipASN1Element(bytes: bytes, offset: &pos)
        }
        
        // Issuer (SEQUENCE of RDN SETs)
        if pos < tbsEnd {
            result.issuer = readX500Name(bytes: bytes, offset: &pos)
        }
        
        // Validity (SEQUENCE of two times)
        if pos < tbsEnd {
            let validityResult = readValidity(bytes: bytes, offset: &pos)
            result.validFrom = validityResult.notBefore
            result.validTo = validityResult.notAfter
        }
        
        return result
    }
    
    // MARK: - ASN.1 Primitives
    
    struct ASN1Element {
        let tag: UInt8
        let contentOffset: Int
        let contentLength: Int
        let totalLength: Int
    }
    
    private func readASN1Length(bytes: [UInt8], offset: inout Int) -> Int? {
        guard offset < bytes.count else { return nil }
        let first = bytes[offset]
        offset += 1
        
        if first < 0x80 {
            return Int(first)
        }
        
        let numBytes = Int(first & 0x7F)
        guard numBytes > 0, numBytes <= 4, offset + numBytes <= bytes.count else { return nil }
        
        var length = 0
        for _ in 0..<numBytes {
            length = (length << 8) | Int(bytes[offset])
            offset += 1
        }
        return length
    }
    
    private func readASN1Element(bytes: [UInt8], offset: inout Int) -> ASN1Element? {
        guard offset < bytes.count else { return nil }
        let tag = bytes[offset]
        let startOffset = offset
        offset += 1
        
        guard let length = readASN1Length(bytes: bytes, offset: &offset) else { return nil }
        let contentOffset = offset
        let totalLength = contentOffset - startOffset + length
        
        return ASN1Element(tag: tag, contentOffset: contentOffset, contentLength: length, totalLength: totalLength)
    }
    
    private func readASN1Sequence(bytes: [UInt8], offset: inout Int) -> ASN1Element? {
        guard let elem = readASN1Element(bytes: bytes, offset: &offset) else { return nil }
        guard elem.tag == 0x30 else { return nil } // SEQUENCE tag
        return elem
    }
    
    private func skipASN1Element(bytes: [UInt8], offset: inout Int) -> Bool {
        guard let elem = readASN1Element(bytes: bytes, offset: &offset) else { return false }
        offset = elem.contentOffset + elem.contentLength
        return true
    }
    
    private func readASN1Integer(bytes: [UInt8], offset: inout Int) -> String? {
        guard let elem = readASN1Element(bytes: bytes, offset: &offset) else { return nil }
        guard elem.tag == 0x02 else { // INTEGER tag
            offset = elem.contentOffset + elem.contentLength
            return nil
        }
        
        let intBytes = Array(bytes[elem.contentOffset..<min(elem.contentOffset + elem.contentLength, bytes.count)])
        offset = elem.contentOffset + elem.contentLength
        return intBytes.map { String(format: "%02X", $0) }.joined()
    }
    
    /// Read an X.500 Name (issuer/subject), extracting the CN component.
    private func readX500Name(bytes: [UInt8], offset: inout Int) -> String? {
        guard let seq = readASN1Sequence(bytes: bytes, offset: &offset) else { return nil }
        let endPos = seq.contentOffset + seq.contentLength
        var pos = seq.contentOffset
        var commonName: String?
        
        while pos < endPos {
            // Each RDN is a SET
            guard let rdnSet = readASN1Element(bytes: bytes, offset: &pos) else { break }
            guard rdnSet.tag == 0x31 else { // SET tag
                pos = rdnSet.contentOffset + rdnSet.contentLength
                continue
            }
            
            var rdnPos = rdnSet.contentOffset
            let rdnEnd = rdnSet.contentOffset + rdnSet.contentLength
            
            while rdnPos < rdnEnd {
                guard let attrSeq = readASN1Sequence(bytes: bytes, offset: &rdnPos) else { break }
                var attrPos = attrSeq.contentOffset
                
                // OID
                guard let oidElem = readASN1Element(bytes: bytes, offset: &attrPos) else { break }
                let oidBytes = Array(bytes[oidElem.contentOffset..<min(oidElem.contentOffset + oidElem.contentLength, bytes.count)])
                attrPos = oidElem.contentOffset + oidElem.contentLength
                
                // Value
                guard let valueElem = readASN1Element(bytes: bytes, offset: &attrPos) else { break }
                let valueBytes = Array(bytes[valueElem.contentOffset..<min(valueElem.contentOffset + valueElem.contentLength, bytes.count)])
                
                // CN OID is 2.5.4.3 = 55 04 03
                if oidBytes == [0x55, 0x04, 0x03] {
                    commonName = String(bytes: valueBytes, encoding: .utf8)
                }
                
                rdnPos = attrSeq.contentOffset + attrSeq.contentLength
            }
            
            pos = rdnSet.contentOffset + rdnSet.contentLength
        }
        
        offset = endPos
        
        if let cn = commonName {
            return "CN=\(cn)"
        }
        return nil
    }
    
    struct ValidityDates {
        var notBefore: String?
        var notAfter: String?
    }
    
    private func readValidity(bytes: [UInt8], offset: inout Int) -> ValidityDates {
        var result = ValidityDates()
        guard let seq = readASN1Sequence(bytes: bytes, offset: &offset) else { return result }
        var pos = seq.contentOffset
        
        result.notBefore = readASN1Time(bytes: bytes, offset: &pos)
        result.notAfter = readASN1Time(bytes: bytes, offset: &pos)
        
        offset = seq.contentOffset + seq.contentLength
        return result
    }
    
    /// Read an ASN.1 UTCTime or GeneralizedTime and format as ISO 8601.
    private func readASN1Time(bytes: [UInt8], offset: inout Int) -> String? {
        guard let elem = readASN1Element(bytes: bytes, offset: &offset) else { return nil }
        let timeBytes = Array(bytes[elem.contentOffset..<min(elem.contentOffset + elem.contentLength, bytes.count)])
        offset = elem.contentOffset + elem.contentLength
        
        guard let timeStr = String(bytes: timeBytes, encoding: .ascii) else { return nil }
        
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        
        var date: Date?
        
        if elem.tag == 0x17 { // UTCTime (YYMMDDHHMMSSZ)
            formatter.dateFormat = "yyMMddHHmmss'Z'"
            date = formatter.date(from: timeStr)
        } else if elem.tag == 0x18 { // GeneralizedTime (YYYYMMDDHHMMSSZ)
            formatter.dateFormat = "yyyyMMddHHmmss'Z'"
            date = formatter.date(from: timeStr)
        }
        
        if let date = date {
            let isoFormatter = ISO8601DateFormatter()
            isoFormatter.formatOptions = [.withInternetDateTime]
            return isoFormatter.string(from: date)
        }
        
        return timeStr
    }
    
    private func normalizeUrl(_ urlString: String) -> String {
        var normalized = urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        if !normalized.hasPrefix("http://") && !normalized.hasPrefix("https://") {
            normalized = "https://\(normalized)"
        }
        return normalized
    }
}
