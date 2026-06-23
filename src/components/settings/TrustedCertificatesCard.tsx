import Ionicons from '@react-native-vector-icons/ionicons/static';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { CertificatePromptModal } from '../CertificatePromptModal';
import { useTheme } from '../../hooks/useTheme';
import { useThemedAlert } from '../../hooks/useThemedAlert';
import { settingsStyles } from '../../styles/settingsStyles';
import { removeTrustForHost, trustCertificateForHost } from '../../services/sslTrustService';
import { authStore } from '../../store/authStore';
import { sslCertStore, type TrustedCertEntry } from '../../store/sslCertStore';
import { getCertificateInfo, type CertificateInfo } from '../../../modules/expo-ssl-trust/src';
import { SettingsSectionTitle } from './SettingsSectionTitle';

export function TrustedCertificatesCard() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { alert } = useThemedAlert();

  const serverUrl = authStore((s) => s.serverUrl);
  const activeHostname = useMemo(() => {
    if (!serverUrl) return null;
    try { return new URL(serverUrl).hostname; } catch { return null; }
  }, [serverUrl]);

  const trustedCerts = sslCertStore((s) => s.trustedCerts);
  const trustedCertEntries = useMemo(() => {
    const entries = Object.entries(trustedCerts) as [string, TrustedCertEntry][];
    return entries.sort((a, b) => {
      if (a[0] === activeHostname) return -1;
      if (b[0] === activeHostname) return 1;
      return b[1].acceptedAt - a[1].acceptedAt;
    });
  }, [trustedCerts, activeHostname]);

  const [certUrlPromptVisible, setCertUrlPromptVisible] = useState(false);
  const [certUrlValue, setCertUrlValue] = useState('');
  const [certFetching, setCertFetching] = useState(false);
  const [certModalVisible, setCertModalVisible] = useState(false);
  const [certInfo, setCertInfo] = useState<CertificateInfo | null>(null);
  const [certHostname, setCertHostname] = useState('');

  const handleRemoveTrustedCert = useCallback((hostname: string) => {
    const isActive = hostname === activeHostname;
    alert(
      isActive ? t('removeActiveCertificate') : t('removeTrustedCertificate'),
      isActive
        ? t('removeActiveCertificateMessage', { hostname })
        : t('removeTrustedCertificateMessage', { hostname }),
      [
        { text: t('cancel'), style: 'cancel' },
        {
          text: t('remove'),
          style: 'destructive',
          onPress: () => {
            removeTrustForHost(hostname).catch(() => {
              /* best-effort removal */
            });
          },
        },
      ],
    );
  }, [alert, activeHostname, t]);

  const normalizeUrl = useCallback((input: string): { url: string; hostname: string } | null => {
    const trimmed = input.trim();
    if (!trimmed) return null;
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    try {
      const parsed = new URL(withScheme);
      parsed.protocol = 'https:';
      return { url: parsed.toString(), hostname: parsed.hostname };
    } catch {
      return null;
    }
  }, []);

  const handleAddCertificate = useCallback(() => {
    setCertUrlValue('');
    setCertUrlPromptVisible(true);
  }, []);

  const handleFetchCertificate = useCallback(async () => {
    const result = normalizeUrl(certUrlValue);
    if (!result) {
      alert(t('invalidUrl'), t('invalidUrlMessage'));
      return;
    }
    setCertUrlPromptVisible(false);
    setCertFetching(true);
    try {
      const info = await getCertificateInfo(result.url);
      if (info.isSystemTrusted) {
        // The device already trusts this cert. Pinning it would do nothing for
        // security and would needlessly route streaming through the loopback
        // proxy (and break at the next cert rotation), so refuse it.
        alert(t('certAlreadyTrustedTitle'), t('certAlreadyTrustedMessage', { hostname: result.hostname }));
        return;
      }
      setCertInfo(info);
      setCertHostname(result.hostname);
      setCertModalVisible(true);
    } catch (e) {
      alert(t('certificateError'), e instanceof Error ? e.message : t('failedToFetchCertificate'));
    } finally {
      setCertFetching(false);
    }
  }, [certUrlValue, normalizeUrl, alert, t]);

  const handleTrustFetchedCert = useCallback(async () => {
    if (!certInfo || !certHostname) return;
    await trustCertificateForHost(certHostname, certInfo.sha256Fingerprint, certInfo.validTo);
    setCertModalVisible(false);
    setCertInfo(null);
  }, [certInfo, certHostname]);

  const handleCancelCert = useCallback(() => {
    setCertModalVisible(false);
    setCertInfo(null);
  }, []);

  return (
    <>
      <View style={settingsStyles.section}>
        <SettingsSectionTitle>{t('trustedCertificates')}</SettingsSectionTitle>
        <View style={[settingsStyles.card, settingsStyles.cardPadded, { backgroundColor: colors.card }]}>
          {trustedCertEntries.length > 0 ? (
            trustedCertEntries.map(([hostname, entry]) => {
              const isActive = hostname === activeHostname;
              const isExpired = !!(entry.validTo && entry.validTo !== 'Unknown' && new Date(entry.validTo) < new Date());
              return (
                <View
                  key={hostname}
                  style={[
                    styles.certRow,
                    { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
                  ]}
                >
                  <View style={styles.certInfo}>
                    <View style={styles.certHeader}>
                      <Ionicons
                        name={isExpired ? 'shield-outline' : isActive ? 'shield-checkmark' : 'shield-checkmark-outline'}
                        size={16}
                        color={isExpired ? colors.red : colors.primary}
                      />
                      <Text style={[styles.certHostname, { color: colors.textPrimary }]}>
                        {hostname}
                      </Text>
                      {isActive && !isExpired && (
                        <View style={[styles.activeDot, { backgroundColor: colors.primary }]} />
                      )}
                      {isExpired && (
                        <Text style={[styles.expiredBadge, { color: colors.red }]}>{t('expired')}</Text>
                      )}
                    </View>
                    <Text style={[styles.certFingerprint, { color: colors.textSecondary }]} numberOfLines={1}>
                      {entry.sha256.substring(0, 23)}...
                    </Text>
                    <Text style={[styles.certDate, { color: isExpired ? colors.red : colors.textSecondary }]}>
                      {t('trustedDate', { date: new Date(entry.acceptedAt).toLocaleDateString() })}
                      {entry.validTo && entry.validTo !== 'Unknown'
                        ? `  ·  ${isExpired ? t('expiredDate', { date: new Date(entry.validTo).toLocaleDateString() }) : t('expiresDate', { date: new Date(entry.validTo).toLocaleDateString() })}`
                        : ''}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => handleRemoveTrustedCert(hostname)}
                    hitSlop={8}
                    style={({ pressed }) => [pressed && settingsStyles.pressed]}
                  >
                    <Ionicons name="close-circle-outline" size={22} color={colors.red} />
                  </Pressable>
                </View>
              );
            })
          ) : (
            <Text style={[styles.placeholder, { color: colors.textSecondary }]}>
              {t('noTrustedCertificates')}
            </Text>
          )}
          {certFetching ? (
            <View style={styles.addRow}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={[styles.addText, { color: colors.primary }]}>{t('fetchingCertificate')}</Text>
            </View>
          ) : (
            <Pressable
              onPress={handleAddCertificate}
              style={({ pressed }) => [styles.addRow, pressed && settingsStyles.pressed]}
            >
              <Ionicons name="add-circle-outline" size={20} color={colors.primary} />
              <Text style={[styles.addText, { color: colors.primary }]}>{t('addCertificate')}</Text>
            </Pressable>
          )}
        </View>
      </View>

      {/* Certificate URL input modal */}
      <Modal
        visible={certUrlPromptVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setCertUrlPromptVisible(false)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setCertUrlPromptVisible(false)}>
          <Pressable style={[styles.modalCard, { backgroundColor: colors.card }]} onPress={() => {}}>
            <Text style={[styles.modalTitle, { color: colors.textPrimary }]}>
              {t('addCertificate')}
            </Text>
            <Text style={[styles.modalHint, { color: colors.textSecondary }]}>
              {t('addCertificateHint')}
            </Text>
            <TextInput
              style={[styles.modalInput, { color: colors.textPrimary, backgroundColor: colors.inputBg, borderColor: colors.border }]}
              value={certUrlValue}
              onChangeText={setCertUrlValue}
              placeholder="https://music.example.com"
              placeholderTextColor={colors.textSecondary}
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              onSubmitEditing={handleFetchCertificate}
            />
            <View style={styles.modalButtons}>
              <Pressable
                onPress={() => setCertUrlPromptVisible(false)}
                style={({ pressed }) => [styles.modalButton, pressed && settingsStyles.pressed]}
              >
                <Text style={[styles.modalButtonText, { color: colors.textSecondary }]}>{t('cancel')}</Text>
              </Pressable>
              <Pressable
                onPress={handleFetchCertificate}
                style={({ pressed }) => [styles.modalButton, pressed && settingsStyles.pressed]}
              >
                <Text style={[styles.modalButtonText, { color: colors.primary }]}>{t('fetch')}</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <CertificatePromptModal
        visible={certModalVisible}
        certInfo={certInfo}
        hostname={certHostname}
        isManualAdd
        onTrust={handleTrustFetchedCert}
        onCancel={handleCancelCert}
      />
    </>
  );
}

const styles = StyleSheet.create({
  certRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    gap: 12,
  },
  certInfo: { flex: 1 },
  certHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  certHostname: { fontSize: 16, fontWeight: '600' },
  certFingerprint: { fontSize: 12, fontFamily: 'monospace', marginBottom: 2 },
  certDate: { fontSize: 12 },
  activeDot: { width: 6, height: 6, borderRadius: 3 },
  expiredBadge: { fontSize: 12, fontWeight: '600' },
  placeholder: { fontSize: 16, fontStyle: 'italic', padding: 16 },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 12 },
  addText: { fontSize: 16, fontWeight: '500' },
  modalBackdrop: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  modalCard: { width: '80%', borderRadius: 14, padding: 20 },
  modalTitle: { fontSize: 16, fontWeight: '600', marginBottom: 16 },
  modalHint: { fontSize: 12, marginBottom: 12 },
  modalInput: {
    fontSize: 16,
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    marginBottom: 16,
  },
  modalButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 16 },
  modalButton: { paddingVertical: 6, paddingHorizontal: 4 },
  modalButtonText: { fontSize: 16, fontWeight: '600' },
});
