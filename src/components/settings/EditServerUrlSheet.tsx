import Ionicons from '@react-native-vector-icons/ionicons/static';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { BottomSheet } from '../BottomSheet';
import { useTheme } from '../../hooks/useTheme';
import { useThemedAlert } from '../../hooks/useThemedAlert';
import { settingsStyles } from '../../styles/settingsStyles';
import { switchToServer } from '../../services/failoverService';
import { syncProxyUpstreams, trustCertificateForHost } from '../../services/sslTrustService';
import { clearApiCache, login, normalizeServerUrl } from '../../services/subsonicService';
import { clearQueue } from '../../services/playerService';
import { authStore } from '../../store/authStore';
import { getCertificateInfo, isSSLError, type CertificateInfo } from '../../../modules/expo-ssl-trust/src';

type TestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'passed'; testedUrl: string }
  | { kind: 'failed'; error: string }
  | {
      // Test hit an untrusted/self-signed cert; show its details inline so the
      // user can trust it without leaving the sheet (a nested modal would stack
      // on this BottomSheet, which the codebase avoids).
      kind: 'cert';
      certInfo: CertificateInfo;
      hostname: string;
      isRotation: boolean;
      testedUrl: string;
    };

/** Best-effort hostname extraction. `normalizeServerUrl` guarantees a scheme,
 *  so `new URL` parses; fall back to the raw string if it somehow doesn't. */
function extractHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Server-URL editor. One component covers both primary and secondary
 * targets — the three divergences (auth-store field, save-time side
 * effects, remove button) are clean conditionals on `target`.
 *
 * Primary save:
 *   - Confirms with the user (queue will clear)
 *   - clearQueue + setSession + clearApiCache
 *   - Leaves serverInfoStore alone (same server, different address)
 *
 * Secondary save:
 *   - No confirm
 *   - setSecondaryServerUrl only
 *   - Remove button visible when secondary is currently set
 */
export function EditServerUrlSheet({
  visible,
  onClose,
  target,
}: {
  visible: boolean;
  onClose: () => void;
  target: 'primary' | 'secondary';
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { confirm } = useThemedAlert();
  const serverUrl = authStore((s) => s.serverUrl);
  const secondaryServerUrl = authStore((s) => s.secondaryServerUrl);
  const activeServer = authStore((s) => s.activeServer);

  const initial = target === 'primary' ? (serverUrl ?? '') : (secondaryServerUrl ?? '');

  const [input, setInput] = useState('');
  const [saved, setSaved] = useState(false);
  const [testState, setTestState] = useState<TestState>({ kind: 'idle' });

  useEffect(() => {
    if (visible) {
      setInput(initial);
      setSaved(false);
      setTestState({ kind: 'idle' });
    }
  }, [visible, initial]);

  const handleInputChange = useCallback((next: string) => {
    setInput(next);
    setTestState((prev) => (prev.kind === 'idle' ? prev : { kind: 'idle' }));
  }, []);

  const handleTest = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed) return;
    const auth = authStore.getState();
    if (!auth.username || !auth.password) {
      setTestState({ kind: 'failed', error: t('connectionFailed') });
      return;
    }
    const normalised = normalizeServerUrl(trimmed);
    setTestState({ kind: 'testing' });
    const result = await login(normalised, auth.username, auth.password, auth.legacyAuth);
    if (result.success) {
      setTestState({ kind: 'passed', testedUrl: normalised });
      return;
    }
    // A self-signed / untrusted TLS rejection blocks the connection. On iOS RN
    // reports it as the generic "network connection was lost" (-1005); pair that
    // with explicit SSL error strings and probe the certificate so the user can
    // trust it inline. getCertificateInfo only succeeds against a live TLS
    // endpoint, so a genuine outage falls through to the plain failure below.
    const errorMsg = result.error || t('connectionFailed');
    const maybeCertIssue =
      isSSLError(errorMsg) ||
      (Platform.OS === 'ios' && /network connection was lost/i.test(errorMsg));
    if (maybeCertIssue) {
      try {
        const info = await getCertificateInfo(normalised);
        if (info.isSystemTrusted) {
          // Valid, system-trusted cert — the failure wasn't a trust problem
          // (likely a transient drop mis-reported as -1005 on iOS). Don't offer
          // to pin a cert the OS already trusts; surface the original error.
          setTestState({ kind: 'failed', error: errorMsg });
          return;
        }
        setTestState({
          kind: 'cert',
          certInfo: info,
          hostname: extractHostname(normalised),
          isRotation: errorMsg.includes('CERT_FINGERPRINT_MISMATCH'),
          testedUrl: normalised,
        });
        return;
      } catch {
        /* cert probe failed (real outage / DNS) — fall through to plain error */
      }
    }
    setTestState({ kind: 'failed', error: errorMsg });
  }, [input, t]);

  // Trust the presented cert, then re-run the test against the same URL so the
  // user lands on the normal 'passed' state and can Save. Mirrors the login
  // screen's trust-then-retry flow.
  const handleTrustCert = useCallback(async () => {
    if (testState.kind !== 'cert') return;
    const { certInfo, hostname, testedUrl } = testState;
    setTestState({ kind: 'testing' });
    try {
      await trustCertificateForHost(hostname, certInfo.sha256Fingerprint, certInfo.validTo);
    } catch (e) {
      setTestState({
        kind: 'failed',
        error: t('failedToTrustCertificate', {
          message: e instanceof Error ? e.message : t('unknownError'),
        }),
      });
      return;
    }
    const auth = authStore.getState();
    if (!auth.username || !auth.password) {
      setTestState({ kind: 'failed', error: t('connectionFailed') });
      return;
    }
    const result = await login(testedUrl, auth.username, auth.password, auth.legacyAuth);
    if (result.success) {
      setTestState({ kind: 'passed', testedUrl });
    } else {
      setTestState({ kind: 'failed', error: result.error });
    }
  }, [testState, t]);

  const applyPrimary = useCallback((normalised: string) => {
    const auth = authStore.getState();
    if (!auth.username || !auth.password || !auth.apiVersion) return;
    clearQueue();
    auth.setSession(normalised, auth.username, auth.password, auth.apiVersion, auth.legacyAuth);
    clearApiCache();
    // Register the now-active host with the iOS streaming proxy. If it's a
    // freshly-trusted self-signed host this is what lets AVPlayer reach it —
    // otherwise getStreamUrl keeps resolving to the raw https URL until the next
    // app launch. No-op on Android / for CA-trusted hosts.
    void syncProxyUpstreams();
    setSaved(true);
    setTimeout(onClose, 500);
  }, [onClose]);

  const handleSave = useCallback(() => {
    if (testState.kind !== 'passed') return;
    const normalised = testState.testedUrl;

    if (target === 'secondary') {
      authStore.getState().setSecondaryServerUrl(normalised);
      // A trusted self-signed secondary must be registered with the proxy too,
      // so streaming works after an automatic/manual failover to it.
      void syncProxyUpstreams();
      setSaved(true);
      setTimeout(onClose, 500);
      return;
    }

    if (normalised === serverUrl) {
      onClose();
      return;
    }
    confirm({
      title: t('serverUrlChangeWarningTitle'),
      message: t('serverUrlChangeWarning'),
      confirmLabel: t('save'),
      onConfirm: () => applyPrimary(normalised),
    });
  }, [testState, target, serverUrl, confirm, t, applyPrimary, onClose]);

  const handleRemove = useCallback(async () => {
    if (activeServer === 'secondary') {
      await switchToServer('primary');
    }
    authStore.getState().setSecondaryServerUrl(null);
    onClose();
  }, [activeServer, onClose]);

  const title = target === 'primary' ? t('serverUrl') : t('secondaryServerUrl');
  const hint = target === 'primary' ? t('serverUrlEditPrompt') : t('secondaryServerUrlEditPrompt');
  const placeholder = target === 'primary' ? 'https://music.example.com' : 'http://192.168.1.50:4040';

  return (
    <BottomSheet visible={visible} onClose={onClose}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: colors.textPrimary }]}>{title}</Text>
        <Text style={[styles.hint, { color: colors.textSecondary }]}>{hint}</Text>
      </View>
      <View style={styles.form}>
        <TextInput
          style={[
            styles.input,
            { backgroundColor: colors.inputBg, color: colors.textPrimary, borderColor: colors.border },
          ]}
          placeholder={placeholder}
          placeholderTextColor={colors.textSecondary}
          value={input}
          onChangeText={handleInputChange}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="go"
          onSubmitEditing={handleTest}
          autoFocus
          editable={testState.kind !== 'testing'}
        />
        {testState.kind === 'passed' && (
          <View style={styles.testStatus}>
            <Ionicons name="checkmark-circle" size={18} color={colors.green ?? colors.primary} />
            <Text style={[styles.testStatusText, { color: colors.textSecondary }]}>
              {t('testPassed')}
            </Text>
          </View>
        )}
        {testState.kind === 'failed' && (
          <View style={styles.testStatus}>
            <Ionicons name="close-circle" size={18} color={colors.red} />
            <Text style={[styles.testStatusText, { color: colors.red }]} numberOfLines={3}>
              {t('testFailed', { error: testState.error })}
            </Text>
          </View>
        )}
        {testState.kind === 'cert' && (
          <View style={styles.certBlock}>
            <View style={styles.certHeaderRow}>
              <Ionicons
                name={testState.isRotation ? 'alert-circle' : 'shield-outline'}
                size={20}
                color={testState.isRotation ? colors.red : colors.orange}
              />
              <Text style={[styles.certTitle, { color: colors.textPrimary }]}>
                {testState.isRotation ? t('certChangedTitle') : t('untrustedCertificateTitle')}
              </Text>
            </View>
            <Text style={[styles.certDescription, { color: colors.textSecondary }]}>
              {testState.isRotation
                ? t('certChangedWarning')
                : t('certUntrustedDescription', { hostname: testState.hostname })}
            </Text>
            <Text style={[styles.certFingerprintLabel, { color: colors.textSecondary }]}>
              {t('sha256Fingerprint')}
            </Text>
            <Text style={[styles.certFingerprint, { color: colors.textPrimary }]} selectable>
              {testState.certInfo.sha256Fingerprint}
            </Text>
            <Pressable
              onPress={handleTrustCert}
              style={({ pressed }) => [
                styles.trustButton,
                { backgroundColor: testState.isRotation ? colors.red : colors.orange },
                pressed && settingsStyles.pressed,
              ]}
            >
              <Ionicons name="shield-checkmark-outline" size={18} color="#fff" />
              <Text style={styles.trustButtonText}>
                {testState.isRotation ? t('trustNewCertificate') : t('trustThisCertificate')}
              </Text>
            </Pressable>
          </View>
        )}
        <View style={styles.buttonRow}>
          <Pressable
            onPress={handleTest}
            disabled={testState.kind === 'testing' || !input.trim()}
            style={({ pressed }) => [
              styles.splitButton,
              styles.testButton,
              { borderColor: colors.primary },
              pressed && settingsStyles.pressed,
              (testState.kind === 'testing' || !input.trim()) && settingsStyles.disabled,
            ]}
          >
            {testState.kind === 'testing' ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <Ionicons name="flask-outline" size={18} color={colors.primary} />
            )}
            <Text style={[styles.splitButtonText, { color: colors.primary }]}>
              {testState.kind === 'testing' ? t('testing') : t('testServer')}
            </Text>
          </Pressable>
          <Pressable
            onPress={handleSave}
            disabled={testState.kind !== 'passed'}
            style={({ pressed }) => [
              styles.splitButton,
              { backgroundColor: colors.primary },
              pressed && settingsStyles.pressed,
              testState.kind !== 'passed' && settingsStyles.disabled,
            ]}
          >
            <Ionicons name="checkmark" size={18} color="#fff" />
            <Text style={[styles.splitButtonText, { color: '#fff' }]}>
              {saved ? t('saved') : t('save')}
            </Text>
          </Pressable>
        </View>
        {target === 'secondary' && secondaryServerUrl != null && (
          <Pressable
            onPress={handleRemove}
            style={({ pressed }) => [styles.cancelButton, pressed && settingsStyles.pressed]}
          >
            <Text style={[styles.cancelButtonText, { color: colors.red }]}>
              {t('removeSecondaryServerUrl')}
            </Text>
          </Pressable>
        )}
        <Pressable onPress={onClose} style={styles.cancelButton}>
          <Text style={[styles.cancelButtonText, { color: colors.primary }]}>{t('cancel')}</Text>
        </Pressable>
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 4, marginBottom: 16 },
  title: { fontSize: 18, fontWeight: '700', marginBottom: 6 },
  hint: { fontSize: 14, lineHeight: 18 },
  form: { paddingHorizontal: 4 },
  input: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  testStatus: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  testStatusText: { flex: 1, fontSize: 14, lineHeight: 18 },
  certBlock: { marginTop: 12, gap: 8 },
  certHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  certTitle: { fontSize: 15, fontWeight: '700' },
  certDescription: { fontSize: 13, lineHeight: 18 },
  certFingerprintLabel: { fontSize: 12, fontWeight: '500', marginTop: 4 },
  certFingerprint: { fontFamily: 'monospace', fontSize: 12, lineHeight: 16 },
  trustButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 12,
    paddingVertical: 12,
    marginTop: 4,
  },
  trustButtonText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  buttonRow: { flexDirection: 'row', gap: 8, marginTop: 16, marginBottom: 8 },
  splitButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 12,
    paddingVertical: 14,
  },
  testButton: { borderWidth: 1, backgroundColor: 'transparent' },
  splitButtonText: { fontSize: 16, fontWeight: '600' },
  cancelButton: { alignItems: 'center', paddingVertical: 12, marginBottom: 4 },
  cancelButtonText: { fontSize: 16, fontWeight: '500' },
});
