// SDK 56: opt out of `expo/fetch` becoming `globalThis.fetch` for the
// Jest workers. The lazy getter in expo/winter/installGlobal.ts loads
// expo-modules-core and the RN DevMenu native module, which have no
// native bridge under jest → invariant violation on any suite that
// touches react-native imports. Setting the env var here (jest.config.js
// runs in the parent Jest process before workers spawn) ensures it
// propagates to every worker.
process.env.EXPO_PUBLIC_USE_RN_FETCH = '1';

module.exports = {
  projects: [
    {
      preset: 'jest-expo/ios',
      displayName: 'ios',
      testMatch: [
        '<rootDir>/modules/**/__tests__/**/*.(test|spec).[jt]s?(x)',
        '<rootDir>/src/**/__tests__/**/*.(test|spec).[jt]s?(x)',
      ],
      moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/$1',
        '^.+/i18n/i18n$': '<rootDir>/src/test-utils/i18nMock.ts',
        // SDK 56 vector-icons migration: redirect every
        // `@react-native-vector-icons/*/static` import to the shared stub.
        '^@react-native-vector-icons/.+/static$': '<rootDir>/src/test-utils/iconMock.tsx',
      },
      setupFiles: ['<rootDir>/src/test-utils/i18nSetup.ts'],
    },
    {
      preset: 'jest-expo/android',
      displayName: 'android',
      testMatch: [
        '<rootDir>/modules/**/__tests__/**/*.(test|spec).[jt]s?(x)',
        '<rootDir>/src/**/__tests__/**/*.(test|spec).[jt]s?(x)',
      ],
      moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/$1',
        '^.+/i18n/i18n$': '<rootDir>/src/test-utils/i18nMock.ts',
        // SDK 56 vector-icons migration: redirect every
        // `@react-native-vector-icons/*/static` import to the shared stub.
        '^@react-native-vector-icons/.+/static$': '<rootDir>/src/test-utils/iconMock.tsx',
      },
      setupFiles: ['<rootDir>/src/test-utils/i18nSetup.ts'],
    },
  ],
  collectCoverageFrom: [
    'modules/expo-async-fs/src/index.ts',
    'modules/expo-backup-exclusions/src/index.ts',
    'modules/expo-gzip/src/index.ts',
    'modules/expo-move-to-back/src/index.ts',
    'modules/expo-ssl-trust/src/ExpoSslTrust.ts',
    'modules/subsonic-api/src/index.ts',
    'modules/subsonic-api/src/utils.ts',
    'modules/subsonic-api/src/md5.ts',
    'src/utils/**/*.ts',
    'src/hooks/usePlaybackAnalytics.ts',
    'src/store/**/*.ts',
    'src/services/**/*.ts',
    '!src/**/__tests__/**',
    '!src/**/__mocks__/**',
  ],
};
