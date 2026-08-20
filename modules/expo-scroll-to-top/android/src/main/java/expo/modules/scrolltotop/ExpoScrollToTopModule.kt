package expo.modules.scrolltotop

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Android has no status-bar-tap-to-scroll-to-top convention, so there is nothing to
 * intercept. Stubbed so the JS surface is identical on both platforms and callers need no
 * platform checks — the same shape `expo-move-to-back` uses in the opposite direction.
 */
class ExpoScrollToTopModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ExpoScrollToTop")

    Events("onStatusBarTap")

    Function("setArmed") { _: Boolean -> }

    Function("isSupported") { false }
  }
}
