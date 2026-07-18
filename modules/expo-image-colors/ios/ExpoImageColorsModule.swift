import ExpoModulesCore
import Foundation
import UIKit

/// Extract a dark/light two-colour palette from a local image.
///
/// Algorithm is documented in the TS wrapper (src/index.ts). Kotlin and
/// Swift implementations are kept byte-identical: same piecewise sRGB
/// linearisation, same Ottosson reference matrices, same hue buckets,
/// same vibrance scoring, same L-clamping + WCAG gate, same gamut retry.
public class ExpoImageColorsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoImageColors")

    AsyncFunction("getImagePaletteAsync") { (uri: String) -> [String: Any?]? in
      let path = Self.resolvePath(uri)
      guard let image = UIImage(contentsOfFile: path),
            let cgImage = image.cgImage else { return nil }

      let width = cgImage.width
      let height = cgImage.height
      guard width > 0, height > 0 else { return nil }

      // Draw into a known RGBA8 buffer so we can byte-walk with predictable layout.
      let colorSpace = CGColorSpaceCreateDeviceRGB()
      let bytesPerPixel = 4
      let bytesPerRow = width * bytesPerPixel
      var pixels = [UInt8](repeating: 0, count: width * height * bytesPerPixel)
      guard let context = CGContext(
        data: &pixels,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: bytesPerRow,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
      ) else { return nil }
      context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))

      return Self.extractPalette(rgba: pixels, width: width, height: height)
    }
  }

  private static func resolvePath(_ uri: String) -> String {
    if uri.hasPrefix("file://") {
      return URL(string: uri)?.path ?? String(uri.dropFirst("file://".count))
    }
    return uri
  }

  // --- Tunable constants (mirrored in Kotlin) ---
  private static let hueBuckets = 24
  private static let rejectLMin = 0.10
  private static let rejectLMax = 0.96
  private static let rejectCMin = 0.04
  private static let secondaryMinHueDistRad = Double.pi / 3.0  // 60°
  private static let darkLMin = 0.22
  private static let darkLMax = 0.40
  private static let darkLFloor = 0.15
  private static let lightLMin = 0.75
  private static let lightLMax = 0.90
  private static let lightLCeiling = 0.96
  private static let darkYMax = 0.18   // 3:1 vs white
  private static let lightYMin = 0.55  // 3:1 vs black
  private static let lStep = 0.02
  private static let chromaShrink = 0.9
  // Primary-hue score = count × avgChroma^exp. exp<1 dampens chroma so the
  // most-used hue leads (exp=1 would be Σchroma). Tunable. (Mirrored in Kotlin.)
  private static let dominantChromaExponent = 0.5

  /// Core extraction. Returns a dict suitable for the Expo Modules bridge to
  /// convert into the TS `Palette` interface, or nil for no-usable-colour.
  private static func extractPalette(rgba: [UInt8], width: Int, height: Int) -> [String: Any?]? {
    var count = [Int](repeating: 0, count: hueBuckets)
    var sumR = [Double](repeating: 0, count: hueBuckets)
    var sumG = [Double](repeating: 0, count: hueBuckets)
    var sumB = [Double](repeating: 0, count: hueBuckets)
    var vibrance = [Double](repeating: 0, count: hueBuckets)

    let pixelCount = width * height
    for i in 0..<pixelCount {
      let o = i * 4
      let aByte = rgba[o + 3]
      if aByte < 128 { continue }
      let r = Double(rgba[o + 0]) / 255.0
      let g = Double(rgba[o + 1]) / 255.0
      let b = Double(rgba[o + 2]) / 255.0

      let rLin = srgbToLinear(r)
      let gLin = srgbToLinear(g)
      let bLin = srgbToLinear(b)

      let lab = linearRgbToOklab(rLin, gLin, bLin)
      let L = lab.0
      let aa = lab.1
      let bb = lab.2
      let C = (aa * aa + bb * bb).squareRoot()

      if L < rejectLMin || L > rejectLMax || C < rejectCMin { continue }

      var hue = atan2(bb, aa)
      if hue < 0 { hue += 2.0 * Double.pi }
      let bucket = min(hueBuckets - 1, max(0, Int(hue * Double(hueBuckets) / (2.0 * Double.pi))))

      count[bucket] += 1
      sumR[bucket] += rLin
      sumG[bucket] += gLin
      sumB[bucket] += bLin
      vibrance[bucket] += C
    }

    // Primary = the dominant hue: the bucket maximising count × avgChroma^exp
    // (population-led, chroma a mild tiebreak), so the tint follows the colour
    // that fills most of the artwork.
    var primaryIdx = -1
    var primaryScore = 0.0
    for i in 0..<hueBuckets {
      if count[i] == 0 { continue }
      let avgC = vibrance[i] / Double(count[i])
      let score = Double(count[i]) * pow(avgC, dominantChromaExponent)
      if score > primaryScore {
        primaryScore = score
        primaryIdx = i
      }
    }
    if primaryIdx < 0 { return nil }

    return [
      "dark": modeVariant(primaryIdx, count, sumR, sumG, sumB, dark: true),
      "light": modeVariant(primaryIdx, count, sumR, sumG, sumB, dark: false),
    ]
  }

  /// Build one `{primary, secondary}` variant for a chosen primary bucket: its
  /// average colour + the max-count bucket ≥ 60° away, clamped for the requested
  /// theme. Mirrors the original single-primary logic.
  private static func modeVariant(
    _ primaryIdx: Int,
    _ count: [Int],
    _ sumR: [Double],
    _ sumG: [Double],
    _ sumB: [Double],
    dark: Bool
  ) -> [String: Any?] {
    let primaryLin = (
      sumR[primaryIdx] / Double(count[primaryIdx]),
      sumG[primaryIdx] / Double(count[primaryIdx]),
      sumB[primaryIdx] / Double(count[primaryIdx])
    )
    var secondaryIdx = -1
    var secondaryCount = 0
    let bucketSpan = 2.0 * Double.pi / Double(hueBuckets)
    for i in 0..<hueBuckets {
      if i == primaryIdx || count[i] == 0 { continue }
      let dist = bucketDistance(primaryIdx, i)
      if Double(dist) * bucketSpan < secondaryMinHueDistRad { continue }
      if count[i] > secondaryCount {
        secondaryCount = count[i]
        secondaryIdx = i
      }
    }
    let secondaryLin: (Double, Double, Double)? = secondaryIdx >= 0 ? (
      sumR[secondaryIdx] / Double(count[secondaryIdx]),
      sumG[secondaryIdx] / Double(count[secondaryIdx]),
      sumB[secondaryIdx] / Double(count[secondaryIdx])
    ) : nil
    if dark {
      return [
        "primary": clampToDarkHex(primaryLin),
        "secondary": secondaryLin.map { clampToDarkHex($0) } as Any?,
      ]
    }
    return [
      "primary": clampToLightHex(primaryLin),
      "secondary": secondaryLin.map { clampToLightHex($0) } as Any?,
    ]
  }

  private static func bucketDistance(_ a: Int, _ b: Int) -> Int {
    let d = abs(a - b)
    return min(d, hueBuckets - d)
  }

  // --- sRGB ↔ linear (piecewise) ---
  private static func srgbToLinear(_ c: Double) -> Double {
    return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
  }
  private static func linearToSrgb(_ c: Double) -> Double {
    let v = c <= 0.0031308 ? c * 12.92 : 1.055 * pow(c, 1.0 / 2.4) - 0.055
    return max(0.0, min(1.0, v))
  }

  // --- Oklab conversion (Björn Ottosson, reference coefficients) ---
  private static func linearRgbToOklab(_ r: Double, _ g: Double, _ b: Double) -> (Double, Double, Double) {
    let l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
    let m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
    let s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
    let l_ = cbrt(l)
    let m_ = cbrt(m)
    let s_ = cbrt(s)
    return (
      0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
      1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
      0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
    )
  }

  private static func oklabToLinearRgb(_ L: Double, _ a: Double, _ b: Double) -> (Double, Double, Double) {
    let l_ = L + 0.3963377774 * a + 0.2158037573 * b
    let m_ = L - 0.1055613458 * a - 0.0638541728 * b
    let s_ = L - 0.0894841775 * a - 1.2914855480 * b
    let l = l_ * l_ * l_
    let m = m_ * m_ * m_
    let s = s_ * s_ * s_
    return (
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
    )
  }

  // --- WCAG relative luminance from LINEAR RGB ---
  private static func relativeLuminance(_ linR: Double, _ linG: Double, _ linB: Double) -> Double {
    return 0.2126 * linR + 0.7152 * linG + 0.0722 * linB
  }

  private static func clampToDarkHex(_ linRgb: (Double, Double, Double)) -> String {
    let lab = linearRgbToOklab(linRgb.0, linRgb.1, linRgb.2)
    let hue = atan2(lab.2, lab.1)
    let C = (lab.1 * lab.1 + lab.2 * lab.2).squareRoot()
    var L = max(darkLMin, min(darkLMax, lab.0))

    var out = clampToRgbHex(L, C, hue)
    while out.y > darkYMax && L > darkLFloor {
      L -= lStep
      out = clampToRgbHex(L, C, hue)
    }
    return out.hex
  }

  private static func clampToLightHex(_ linRgb: (Double, Double, Double)) -> String {
    let lab = linearRgbToOklab(linRgb.0, linRgb.1, linRgb.2)
    let hue = atan2(lab.2, lab.1)
    let C = (lab.1 * lab.1 + lab.2 * lab.2).squareRoot()
    var L = max(lightLMin, min(lightLMax, lab.0))

    var out = clampToRgbHex(L, C, hue)
    while out.y < lightYMin && L < lightLCeiling {
      L += lStep
      out = clampToRgbHex(L, C, hue)
    }
    return out.hex
  }

  private struct ClampResult {
    let hex: String
    let y: Double
  }

  /// Render (L, C, hue) → sRGB hex, shrinking chroma until in-gamut. Returns
  /// the rendered hex plus its WCAG Y so the caller can gate on contrast.
  private static func clampToRgbHex(_ L: Double, _ startC: Double, _ hue: Double) -> ClampResult {
    var C = startC
    var lin: (Double, Double, Double) = (0, 0, 0)
    var iterations = 0
    while iterations < 8 {
      let a = C * cos(hue)
      let b = C * sin(hue)
      lin = oklabToLinearRgb(L, a, b)
      if lin.0 >= 0 && lin.0 <= 1 && lin.1 >= 0 && lin.1 <= 1 && lin.2 >= 0 && lin.2 <= 1 { break }
      C *= chromaShrink
      iterations += 1
    }
    let rLin = max(0.0, min(1.0, lin.0))
    let gLin = max(0.0, min(1.0, lin.1))
    let bLin = max(0.0, min(1.0, lin.2))
    let y = relativeLuminance(rLin, gLin, bLin)
    let hex = rgbLinearToHex(rLin, gLin, bLin)
    return ClampResult(hex: hex, y: y)
  }

  private static func rgbLinearToHex(_ rLin: Double, _ gLin: Double, _ bLin: Double) -> String {
    let r = max(0, min(255, Int(linearToSrgb(rLin) * 255.0 + 0.5)))
    let g = max(0, min(255, Int(linearToSrgb(gLin) * 255.0 + 0.5)))
    let b = max(0, min(255, Int(linearToSrgb(bLin) * 255.0 + 0.5)))
    return String(format: "#%02X%02X%02X", r, g, b)
  }
}
