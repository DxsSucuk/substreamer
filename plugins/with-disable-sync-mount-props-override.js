const { withMainApplication } = require('expo/config-plugins');

/**
 * Disable React Native 0.86's Android feature flag
 * `overrideBySynchronousMountPropsAtMountingAndroid` (which DEFAULTS TO TRUE).
 *
 * When on, `SurfaceMountingManager.updateProps` merges direct-manipulation
 * "synchronous mount props" (how Reanimated / Native Animated push `transform`
 * and `opacity` under Fabric) onto React's incoming props and `assert()`s that
 * the incoming `transform` is an Array and `opacity` is a Number. A Reanimated-
 * animated view whose props arrive with a mismatched type mid-mount trips that
 * assert → `java.lang.AssertionError: Assertion failed` in
 * `SurfaceMountingManager.overridePropsReadableMap`, crashing the app. We hit it
 * on the now-playing EQ indicator (animates `transform: scaleY`) and the opacity
 * banners. New + default-on in RN 0.86, i.e. since the SDK 57 upgrade.
 *
 * We can't patch RN source (it ships prebuilt here → source patches are inert),
 * but a runtime feature-flag override works on the prebuilt binary. It must run
 * before ANY flag is read, so we inject it at the very start of
 * `MainApplication.onCreate()`, before `super.onCreate()`.
 *
 * Trade-off: we lose a minor anti-flicker optimisation (an animated view could
 * briefly show its pre-animation value when a React commit lands mid-animation)
 * in exchange for not crashing. Revisit if a later RN fixes the assert.
 */

const IMPORT_MARKER = 'com.facebook.react.internal.featureflags.ReactNativeFeatureFlagsDefaults';
const IMPORTS =
  'import com.facebook.react.internal.featureflags.ReactNativeFeatureFlags\n' +
  'import com.facebook.react.internal.featureflags.ReactNativeFeatureFlagsDefaults\n';

const METHOD_MARKER = 'overrideBySynchronousMountPropsAtMountingAndroid';
const OVERRIDE_BLOCK =
  '    // Disable RN 0.86 synchronous-mount-props override (default-on) — its\n' +
  '    // updateProps merge asserts transform is Array / opacity is Number and\n' +
  '    // crashes when a Reanimated-animated view gets a mismatched props update\n' +
  '    // mid-mount. Must run before any feature flag is read.\n' +
  '    ReactNativeFeatureFlags.override(\n' +
  '        object : ReactNativeFeatureFlagsDefaults() {\n' +
  '          override fun overrideBySynchronousMountPropsAtMountingAndroid(): Boolean = false\n' +
  '        }\n' +
  '    )\n';

function withDisableSyncMountPropsOverride(config) {
  return withMainApplication(config, (cfg) => {
    let contents = cfg.modResults.contents;

    if (cfg.modResults.language !== 'kt') {
      // Expo SDK 57 / RN 0.86 generates Kotlin MainApplication; bail loudly if not.
      // eslint-disable-next-line no-console
      console.warn(
        '[with-disable-sync-mount-props-override] MainApplication is not Kotlin; skipping.',
      );
      return cfg;
    }

    // 1. Imports (idempotent) — after the package declaration.
    if (!contents.includes(IMPORT_MARKER)) {
      contents = contents.replace(/^(package .+\n)/m, `$1\n${IMPORTS}`);
    }

    // 2. Override at the very start of onCreate() (idempotent), before super.onCreate().
    if (!contents.includes(METHOD_MARKER)) {
      const before = contents;
      contents = contents.replace(
        /(override fun onCreate\(\)\s*\{\n)/,
        `$1${OVERRIDE_BLOCK}`,
      );
      if (contents === before) {
        // eslint-disable-next-line no-console
        console.warn(
          '[with-disable-sync-mount-props-override] could not find onCreate() to patch.',
        );
      }
    }

    cfg.modResults.contents = contents;
    return cfg;
  });
}

module.exports = withDisableSyncMountPropsOverride;
