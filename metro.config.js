// Learn more: https://docs.expo.dev/guides/customizing-metro/
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// `react-native-queue-player` is a `file:` symlink into a sibling monorepo that
// ships its own nested `node_modules/{react,react-native}`. Metro, following
// imports *inside* RNQP, resolves those duplicates → a SECOND React instance,
// which surfaces as "Cannot read property 'useState' of null" the moment an
// RNQP hook (useCast/useAudioRoute) renders. Force React + React Native to the
// app's single copy. Both are the same version as RNQP's nested copies, so this
// only dedupes instances — no version change. (RNQP's nitro-modules copy is
// left alone: its 0.36.1 JS already works against the app's 0.35.10 native.)
const FORCE_APP_COPY = [/^react$/, /^react\//, /^react-native$/, /^react-native\//];
const APP_ORIGIN = path.join(__dirname, 'index.js');

const upstreamResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = upstreamResolveRequest ?? context.resolveRequest;
  if (FORCE_APP_COPY.some((re) => re.test(moduleName))) {
    // Resolve as if the import originated at the app root so node resolution
    // walks up into the app's own node_modules first.
    return context.resolveRequest({ ...context, originModulePath: APP_ORIGIN }, moduleName, platform);
  }
  return resolve(context, moduleName, platform);
};

module.exports = config;
