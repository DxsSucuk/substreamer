package expo.modules.imagecolors

import android.graphics.BitmapFactory
import android.net.Uri
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlin.math.atan2
import kotlin.math.cbrt
import kotlin.math.cos
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Extract a dark/light two-colour palette from a local image.
 *
 * Algorithm is documented in the TS wrapper (src/index.ts). Kotlin and
 * Swift implementations are kept byte-identical: same piecewise sRGB
 * linearisation, same Ottosson reference matrices, same hue buckets,
 * same vibrance scoring, same L-clamping + WCAG gate, same gamut retry.
 */
class ExpoImageColorsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ExpoImageColors")

    AsyncFunction("getImagePaletteAsync") { uri: String ->
      val path = resolvePath(uri) ?: return@AsyncFunction null

      val bitmap = BitmapFactory.decodeFile(path) ?: return@AsyncFunction null
      val width = bitmap.width
      val height = bitmap.height
      if (width <= 0 || height <= 0) return@AsyncFunction null

      val pixels = IntArray(width * height)
      bitmap.getPixels(pixels, 0, width, 0, 0, width, height)
      bitmap.recycle()

      extractPalette(pixels)
    }
  }

  private fun resolvePath(uri: String): String? {
    if (uri.startsWith("file://")) return Uri.parse(uri).path
    return uri
  }

  // --- Tunable constants (mirrored in Swift) ---
  private val hueBuckets = 24
  private val rejectLMin = 0.10
  private val rejectLMax = 0.96
  private val rejectCMin = 0.04
  private val secondaryMinHueDistRad = Math.PI / 3.0  // 60°
  // Dark variant clamp band (Oklab L)
  private val darkLMin = 0.22
  private val darkLMax = 0.40
  private val darkLFloor = 0.15
  // Light variant clamp band
  private val lightLMin = 0.75
  private val lightLMax = 0.90
  private val lightLCeiling = 0.96
  // WCAG relative-luminance gates (Y)
  private val darkYMax = 0.18   // 3:1 vs white (#fff has Y=1)
  private val lightYMin = 0.55  // 3:1 vs black (#000 has Y=0)
  private val lStep = 0.02
  private val chromaShrink = 0.9
  // Primary-hue score = count × avgChroma^exp. exp<1 dampens chroma so the
  // most-used hue leads (exp=1 would be Σchroma). Tunable. (Mirrored in Swift.)
  private val dominantChromaExponent = 0.5

  /**
   * Core extraction. Returns a Map suitable for the Expo Modules bridge to
   * convert into the TS `Palette` interface, or null for no-usable-colour.
   */
  private fun extractPalette(pixels: IntArray): Map<String, Any?>? {
    val count = IntArray(hueBuckets)
    val sumR = DoubleArray(hueBuckets)
    val sumG = DoubleArray(hueBuckets)
    val sumB = DoubleArray(hueBuckets)
    val vibrance = DoubleArray(hueBuckets)

    val oklab = DoubleArray(3)
    val rgbLin = DoubleArray(3)

    for (px in pixels) {
      val a = (px ushr 24) and 0xFF
      if (a < 128) continue
      val r = ((px ushr 16) and 0xFF) / 255.0
      val g = ((px ushr 8) and 0xFF) / 255.0
      val b = (px and 0xFF) / 255.0

      rgbLin[0] = srgbToLinear(r)
      rgbLin[1] = srgbToLinear(g)
      rgbLin[2] = srgbToLinear(b)

      linearRgbToOklab(rgbLin, oklab)
      val L = oklab[0]
      val aa = oklab[1]
      val bb = oklab[2]
      val C = sqrt(aa * aa + bb * bb)

      if (L < rejectLMin || L > rejectLMax || C < rejectCMin) continue

      val hue = (atan2(bb, aa) + 2.0 * Math.PI) % (2.0 * Math.PI)
      val bucket = (hue * hueBuckets / (2.0 * Math.PI)).toInt().coerceIn(0, hueBuckets - 1)

      count[bucket]++
      sumR[bucket] += rgbLin[0]
      sumG[bucket] += rgbLin[1]
      sumB[bucket] += rgbLin[2]
      vibrance[bucket] += C
    }

    // Primary = the dominant hue: the bucket maximising count × avgChroma^exp
    // (population-led, chroma a mild tiebreak), so the tint follows the colour
    // that fills most of the artwork.
    var primaryIdx = -1
    var primaryScore = 0.0
    for (i in 0 until hueBuckets) {
      if (count[i] == 0) continue
      val avgC = vibrance[i] / count[i]
      val score = count[i] * Math.pow(avgC, dominantChromaExponent)
      if (score > primaryScore) {
        primaryScore = score
        primaryIdx = i
      }
    }
    if (primaryIdx < 0) return null

    return mapOf(
      "dark" to modeVariant(primaryIdx, count, sumR, sumG, sumB, dark = true),
      "light" to modeVariant(primaryIdx, count, sumR, sumG, sumB, dark = false),
    )
  }

  /**
   * Build one {primary, secondary} variant for a chosen primary bucket: its
   * average colour + the max-count bucket ≥ 60° away, clamped for the requested
   * theme. Mirrors the original single-primary logic.
   */
  private fun modeVariant(
    primaryIdx: Int,
    count: IntArray,
    sumR: DoubleArray,
    sumG: DoubleArray,
    sumB: DoubleArray,
    dark: Boolean,
  ): Map<String, Any?> {
    val primaryLin = doubleArrayOf(
      sumR[primaryIdx] / count[primaryIdx],
      sumG[primaryIdx] / count[primaryIdx],
      sumB[primaryIdx] / count[primaryIdx],
    )
    var secondaryIdx = -1
    var secondaryCount = 0
    val bucketSpan = 2.0 * Math.PI / hueBuckets
    for (i in 0 until hueBuckets) {
      if (i == primaryIdx || count[i] == 0) continue
      val distBuckets = bucketDistance(primaryIdx, i)
      if (distBuckets * bucketSpan < secondaryMinHueDistRad) continue
      if (count[i] > secondaryCount) {
        secondaryCount = count[i]
        secondaryIdx = i
      }
    }
    val secondaryLin = if (secondaryIdx >= 0) doubleArrayOf(
      sumR[secondaryIdx] / count[secondaryIdx],
      sumG[secondaryIdx] / count[secondaryIdx],
      sumB[secondaryIdx] / count[secondaryIdx],
    ) else null
    return if (dark) mapOf(
      "primary" to clampToDarkHex(primaryLin),
      "secondary" to secondaryLin?.let { clampToDarkHex(it) },
    ) else mapOf(
      "primary" to clampToLightHex(primaryLin),
      "secondary" to secondaryLin?.let { clampToLightHex(it) },
    )
  }

  // --- Hue-bucket distance on a circular 24-bucket wheel ---
  private fun bucketDistance(a: Int, b: Int): Int {
    val d = kotlin.math.abs(a - b)
    return minOf(d, hueBuckets - d)
  }

  // --- sRGB ↔ linear (piecewise, NOT pow(x, 2.2)) ---
  private fun srgbToLinear(c: Double): Double =
    if (c <= 0.04045) c / 12.92 else ((c + 0.055) / 1.055).pow(2.4)

  private fun linearToSrgb(c: Double): Double {
    val v = if (c <= 0.0031308) c * 12.92 else 1.055 * c.pow(1.0 / 2.4) - 0.055
    return v.coerceIn(0.0, 1.0)
  }

  // --- Oklab conversion (Björn Ottosson, reference coefficients) ---
  private fun linearRgbToOklab(rgb: DoubleArray, out: DoubleArray) {
    val l = 0.4122214708 * rgb[0] + 0.5363325363 * rgb[1] + 0.0514459929 * rgb[2]
    val m = 0.2119034982 * rgb[0] + 0.6806995451 * rgb[1] + 0.1073969566 * rgb[2]
    val s = 0.0883024619 * rgb[0] + 0.2817188376 * rgb[1] + 0.6299787005 * rgb[2]
    val l_ = cbrt(l)
    val m_ = cbrt(m)
    val s_ = cbrt(s)
    out[0] = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_
    out[1] = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_
    out[2] = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
  }

  private fun oklabToLinearRgb(lab: DoubleArray, out: DoubleArray) {
    val l_ = lab[0] + 0.3963377774 * lab[1] + 0.2158037573 * lab[2]
    val m_ = lab[0] - 0.1055613458 * lab[1] - 0.0638541728 * lab[2]
    val s_ = lab[0] - 0.0894841775 * lab[1] - 1.2914855480 * lab[2]
    val l = l_ * l_ * l_
    val m = m_ * m_ * m_
    val s = s_ * s_ * s_
    out[0] = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
    out[1] = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
    out[2] = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  }

  // --- WCAG relative luminance from LINEAR RGB ---
  private fun relativeLuminance(linR: Double, linG: Double, linB: Double): Double =
    0.2126 * linR + 0.7152 * linG + 0.0722 * linB

  /** Clamp the colour's Oklab L into the dark band, tighten until WCAG Y ≤ 0.18, shrink chroma as needed for gamut. */
  private fun clampToDarkHex(linRgb: DoubleArray): String {
    val oklab = DoubleArray(3)
    linearRgbToOklab(linRgb, oklab)
    val hue = atan2(oklab[2], oklab[1])
    var C = sqrt(oklab[1] * oklab[1] + oklab[2] * oklab[2])
    var L = oklab[0].coerceIn(darkLMin, darkLMax)

    var out = clampToRgbHex(L, C, hue)
    while (out.y > darkYMax && L > darkLFloor) {
      L -= lStep
      out = clampToRgbHex(L, C, hue)
    }
    // If gamut forced C to zero but Y still high, that's fine — we end grey-ish.
    return out.hex
  }

  /** Clamp into the light band, tighten until WCAG Y ≥ 0.55, shrink chroma as needed for gamut. */
  private fun clampToLightHex(linRgb: DoubleArray): String {
    val oklab = DoubleArray(3)
    linearRgbToOklab(linRgb, oklab)
    val hue = atan2(oklab[2], oklab[1])
    var C = sqrt(oklab[1] * oklab[1] + oklab[2] * oklab[2])
    var L = oklab[0].coerceIn(lightLMin, lightLMax)

    var out = clampToRgbHex(L, C, hue)
    while (out.y < lightYMin && L < lightLCeiling) {
      L += lStep
      out = clampToRgbHex(L, C, hue)
    }
    return out.hex
  }

  private data class ClampResult(val hex: String, val y: Double)

  /**
   * Render (L, C, hue) → sRGB hex, shrinking chroma until in-gamut. Returns
   * the rendered hex plus its WCAG Y so the caller can gate on contrast.
   */
  private fun clampToRgbHex(L: Double, startC: Double, hue: Double): ClampResult {
    val lab = DoubleArray(3)
    val lin = DoubleArray(3)
    var C = startC
    lab[0] = L
    var iterations = 0
    while (iterations < 8) {
      lab[1] = C * cos(hue)
      lab[2] = C * sin(hue)
      oklabToLinearRgb(lab, lin)
      if (lin[0] in 0.0..1.0 && lin[1] in 0.0..1.0 && lin[2] in 0.0..1.0) break
      C *= chromaShrink
      iterations++
    }
    // Final snap-to-gamut in case we ran out of iterations.
    val rLin = lin[0].coerceIn(0.0, 1.0)
    val gLin = lin[1].coerceIn(0.0, 1.0)
    val bLin = lin[2].coerceIn(0.0, 1.0)
    val y = relativeLuminance(rLin, gLin, bLin)
    val hex = rgbLinearToHex(rLin, gLin, bLin)
    return ClampResult(hex, y)
  }

  private fun rgbLinearToHex(rLin: Double, gLin: Double, bLin: Double): String {
    val r = (linearToSrgb(rLin) * 255.0 + 0.5).toInt().coerceIn(0, 255)
    val g = (linearToSrgb(gLin) * 255.0 + 0.5).toInt().coerceIn(0, 255)
    val b = (linearToSrgb(bLin) * 255.0 + 0.5).toInt().coerceIn(0, 255)
    return "#%02X%02X%02X".format(r, g, b)
  }
}
