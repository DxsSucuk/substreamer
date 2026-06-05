let mockManufacturer: string | null = 'Amazon';
jest.mock('expo-device', () => ({
  get manufacturer() {
    return mockManufacturer;
  },
}));

import { Platform } from 'react-native';
import { isFireOS } from '../isFireOS';

const originalOS = Platform.OS;

afterEach(() => {
  (Platform as unknown as { OS: string }).OS = originalOS;
  mockManufacturer = 'Amazon';
});

describe('isFireOS', () => {
  it('is true on Android when the manufacturer is Amazon', () => {
    (Platform as unknown as { OS: string }).OS = 'android';
    mockManufacturer = 'Amazon';
    expect(isFireOS()).toBe(true);
  });

  it('is false on Android for a non-Amazon manufacturer', () => {
    (Platform as unknown as { OS: string }).OS = 'android';
    mockManufacturer = 'Google';
    expect(isFireOS()).toBe(false);
  });

  it('is false when manufacturer is null', () => {
    (Platform as unknown as { OS: string }).OS = 'android';
    mockManufacturer = null;
    expect(isFireOS()).toBe(false);
  });

  it('is false on iOS regardless of manufacturer', () => {
    (Platform as unknown as { OS: string }).OS = 'ios';
    mockManufacturer = 'Amazon';
    expect(isFireOS()).toBe(false);
  });
});
