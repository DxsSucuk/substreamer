const { withXcodeProject } = require("expo/config-plugins");

/**
 * Config plugin that silences the Xcode warning:
 *   "Run script build phase '[Expo Dev Launcher] Strip Local Network Keys
 *   for Release' will be run during every build because it does not specify
 *   any outputs."
 *
 * Why this exists:
 *   expo-dev-launcher injects a shell script build phase into the main app
 *   target that strips local network permission keys from the Info.plist
 *   during release builds. The script phase declares no output files,
 *   causing Xcode to warn on every build. The warning is cosmetic but adds
 *   noise and can mask real warnings.
 *
 * READ THIS BEFORE TOUCHING THE LOCAL-NETWORK KEYS IN app.json:
 *   That strip phase is why fresh iOS installs could not reach LAN servers or
 *   discover Chromecast devices. It deletes NSLocalNetworkUsageDescription
 *   from every non-Debug build *if the value contains the literal string
 *   "Expo Dev Launcher"* — which it did, because dev-launcher sets its own
 *   description first and nothing of ours overrode it.
 *
 *   Our own description in app.json defeats it purely by not containing that
 *   phrase. Reword it into anything containing "Expo Dev Launcher" and every
 *   production build silently loses local network access again. The warning
 *   lives here rather than beside the key because app.json is JSON.parse'd
 *   and rewritten by scripts/create-release.js, so a comment there would both
 *   break the release script and be erased by it.
 *
 *   Two related couplings on NSBonjourServices in app.json:
 *     - "_<ID>._googlecast._tcp" must track chromecastReceiverAppId in the
 *       react-native-queue-player plugin options, or RNQP appends the new
 *       type alongside our stale one.
 *     - Our entry must be UPPERCASE. RNQP uppercases the ID before deriving
 *       its type but dedups with a case-sensitive includes(), so a lowercase
 *       entry of ours ships two near-duplicates.
 *   The strip only ever removes "_expo._tcp" (and drops the array entirely if
 *   that leaves it empty), so declaring our own types is what stops the array
 *   being deleted outright.
 *
 * What it does:
 *   During `expo prebuild`, this plugin finds the "[Expo Dev Launcher]
 *   Strip Local Network Keys for Release" script phase in the main app
 *   target and sets `alwaysOutOfDate = "1"`. This tells Xcode the phase
 *   is intentionally input/output-less and suppresses the warning.
 *
 * Impact:
 *   - Build-time only; no effect on app behaviour.
 *   - If a future expo-dev-launcher version adds output declarations to
 *     the script phase, this plugin becomes a no-op and can be removed.
 */
function withSilenceDevLauncherWarning(config) {
  return withXcodeProject(config, (config) => {
    const project = config.modResults;
    const shellScriptPhases =
      project.hash.project.objects["PBXShellScriptBuildPhase"];

    for (const key of Object.keys(shellScriptPhases)) {
      const phase = shellScriptPhases[key];
      if (typeof phase !== "object") continue;
      if (
        phase.name &&
        phase.name.includes("Expo Dev Launcher") &&
        phase.name.includes("Strip Local Network")
      ) {
        phase.alwaysOutOfDate = 1;
      }
    }

    return config;
  });
}

module.exports = withSilenceDevLauncherWarning;
