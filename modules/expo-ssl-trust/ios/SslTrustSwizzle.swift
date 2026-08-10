import Foundation
import ObjectiveC

// Whether the URLSessionConfiguration swizzle has been installed (extensions
// can't hold stored properties, so this lives at file scope). Installed once
// from the module's OnCreate on the main thread.
private var sslTrustSwizzleInstalled = false

/// Makes React Native's NSURLSession networking consult `SslTrustURLProtocol`.
///
/// RN's `RCTHTTPRequestHandler` builds its session from
/// `URLSessionConfiguration.defaultSessionConfiguration`, and a session created
/// from an explicit configuration consults ONLY that configuration's
/// `protocolClasses` — it ignores globally `URLProtocol.registerClass`-registered
/// protocols. So we swizzle the `default` class getter to prepend our protocol
/// to the returned configuration. Mirrors expo-dev-launcher's
/// `DevLauncherNetworkInterceptor` swizzle.
///
/// We swizzle ONLY `default` (what RN, expo-image and the download module use),
/// not `ephemeral` — so `SslTrustProxy`'s own ephemeral upstream session stays
/// clean and uses its own pinned-trust delegate.
extension URLSessionConfiguration {
    @objc static func sslTrustInstallSwizzle() {
        guard !sslTrustSwizzleInstalled else { return }
        sslTrustSwizzleInstalled = true

        guard
            let original = class_getClassMethod(
                URLSessionConfiguration.self,
                #selector(getter: URLSessionConfiguration.default)
            ),
            let swizzled = class_getClassMethod(
                URLSessionConfiguration.self,
                #selector(getter: URLSessionConfiguration.sslTrust_default)
            )
        else {
            SslTrustLogger.log("swizzle: could not resolve URLSessionConfiguration.default")
            return
        }
        method_exchangeImplementations(original, swizzled)
        SslTrustLogger.log("URLSession swizzle installed")
    }

    // After the exchange, calling `self.sslTrust_default` invokes the ORIGINAL
    // `default` implementation; we then inject our protocol into the result.
    @objc class var sslTrust_default: URLSessionConfiguration {
        let config = self.sslTrust_default
        var classes = config.protocolClasses ?? []
        if !classes.contains(where: { $0 == SslTrustURLProtocol.self }) {
            classes.insert(SslTrustURLProtocol.self, at: 0)
            config.protocolClasses = classes
        }
        return config
    }
}
