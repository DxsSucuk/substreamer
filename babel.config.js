module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    env: {
      // Production builds (BABEL_ENV/NODE_ENV=production, e.g. EAS release
      // builds and `expo export`) strip ALL console.* calls. The app has its
      // own opt-in file-based logging (see the Logging screen / imageCacheLogger
      // + diagnostics stores) for anything user-facing, so console output is
      // dev-only noise that isn't visible to users — no point shipping it or
      // spending cycles on it. Dev builds keep console intact.
      production: {
        plugins: ['transform-remove-console'],
      },
    },
  };
};
