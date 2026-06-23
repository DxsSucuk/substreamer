import { certPromptStore } from '../certPromptStore';
import { type CertificateInfo } from '../../../modules/expo-ssl-trust/src';

const MOCK_CERT: CertificateInfo = {
  sha256Fingerprint: 'AA:BB:CC',
  subject: 'CN=example.com',
  issuer: 'CN=Test CA',
  validFrom: '2025-01-01T00:00:00Z',
  validTo: '2027-01-01T00:00:00Z',
  serialNumber: '01',
  isSelfSigned: false,
  isSystemTrusted: false,
};

beforeEach(() => {
  certPromptStore.getState().hide();
});

describe('certPromptStore', () => {
  it('starts hidden with no cert info', () => {
    const state = certPromptStore.getState();
    expect(state.visible).toBe(false);
    expect(state.certInfo).toBeNull();
    expect(state.hostname).toBe('');
    expect(state.isRotation).toBe(false);
  });

  it('show() sets visible, certInfo, hostname, and isRotation', () => {
    certPromptStore.getState().show(MOCK_CERT, 'example.com', false);
    const state = certPromptStore.getState();
    expect(state.visible).toBe(true);
    expect(state.certInfo).toEqual(MOCK_CERT);
    expect(state.hostname).toBe('example.com');
    expect(state.isRotation).toBe(false);
  });

  it('show() with isRotation true', () => {
    certPromptStore.getState().show(MOCK_CERT, 'example.com', true);
    expect(certPromptStore.getState().isRotation).toBe(true);
  });

  it('hide() resets all state', () => {
    certPromptStore.getState().show(MOCK_CERT, 'example.com', true);
    certPromptStore.getState().hide();
    const state = certPromptStore.getState();
    expect(state.visible).toBe(false);
    expect(state.certInfo).toBeNull();
    expect(state.hostname).toBe('');
    expect(state.isRotation).toBe(false);
  });
});
