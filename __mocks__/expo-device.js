// Auto-applied mock for the `expo-device` native module under Jest (its native
// counterpart 'ExpoDevice' has no bridge in the test env). Defaults to a
// non-Amazon manufacturer so `isFireOS()` is false in the general suite; tests
// that need Fire-specific behaviour mock `expo-device` themselves.
module.exports = {
  manufacturer: null,
  brand: null,
  modelName: null,
  osName: null,
  osVersion: null,
};
