import Ionicons from "@react-native-vector-icons/ionicons/static";
import { memo, useCallback } from 'react';
import i18next from 'i18next';
import { useTranslation } from 'react-i18next';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { BottomSheet } from './BottomSheet';
import { useTheme } from '../hooks/useTheme';
import { type CertificateInfo } from '../../modules/expo-ssl-trust/src';

export interface CertificatePromptModalProps {
  /** Whether the modal is visible */
  visible: boolean;
  /** The certificate information to display */
  certInfo: CertificateInfo | null;
  /** The server hostname */
  hostname: string;
  /** Whether this is a certificate rotation (fingerprint changed) */
  isRotation?: boolean;
  /** Whether the user is manually adding this cert from settings (non-alarming tone for valid certs) */
  isManualAdd?: boolean;
  /** Called when the user accepts the certificate */
  onTrust: () => void;
  /** Called when the user cancels */
  onCancel: () => void;
}

export const CertificatePromptModal = memo(function CertificatePromptModal({
  visible,
  certInfo,
  hostname,
  isRotation = false,
  isManualAdd = false,
  onTrust,
  onCancel,
}: CertificatePromptModalProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();

  const handleTrust = useCallback(() => {
    onTrust();
  }, [onTrust]);

  const handleCancel = useCallback(() => {
    onCancel();
  }, [onCancel]);

  if (!certInfo) return null;

  return (
    <BottomSheet visible={visible} onClose={onCancel} maxHeight="85%" scrollable>
      <View style={styles.content}>
          {/* Header */}
          <View style={styles.headerRow}>
            <Ionicons
              name={isRotation ? 'alert-circle' : isManualAdd && certInfo.isSystemTrusted ? 'shield-checkmark-outline' : 'shield-outline'}
              size={28}
              color={isRotation ? colors.red : isManualAdd && certInfo.isSystemTrusted ? colors.primary : colors.orange}
            />
            <Text style={[styles.title, { color: colors.textPrimary }]}>
              {isRotation ? t('certChangedTitle') : isManualAdd && certInfo.isSystemTrusted ? t('certDetailsTitle') : t('untrustedCertificateTitle')}
            </Text>
          </View>

          {isRotation ? (
            <Text style={[styles.warning, { color: colors.red }]}>
              {t('certChangedWarning')}
            </Text>
          ) : isManualAdd && certInfo.isSystemTrusted ? (
            <Text style={[styles.description, { color: colors.textSecondary }]}>
              {t('certValidDescription', { hostname })}
            </Text>
          ) : (
            <Text style={[styles.description, { color: colors.textSecondary }]}>
              {t('certUntrustedDescription', { hostname })}
            </Text>
          )}

          {/* Certificate Details */}
          <View
            style={[styles.detailsCard, { backgroundColor: colors.background }]}
          >
            <DetailRow
              label={t('certDetailServer')}
              value={hostname}
              colors={colors}
            />
            <DetailRow
              label={t('certDetailSubject')}
              value={certInfo.subject}
              colors={colors}
            />
            <DetailRow
              label={t('certDetailIssuer')}
              value={certInfo.issuer}
              colors={colors}
            />
            <DetailRow
              label={t('certDetailSelfSigned')}
              value={certInfo.isSelfSigned ? t('yes') : t('no')}
              colors={colors}
            />
            <DetailRow
              label={t('certDetailValidFrom')}
              value={formatDate(certInfo.validFrom)}
              colors={colors}
            />
            <DetailRow
              label={t('certDetailValidTo')}
              value={formatDate(certInfo.validTo)}
              colors={colors}
            />
            <DetailRow
              label={t('certDetailSerial')}
              value={certInfo.serialNumber}
              colors={colors}
              mono
            />
          </View>

          {/* Fingerprint section - prominent */}
          <Text
            style={[styles.fingerprintLabel, { color: colors.textSecondary }]}
          >
            {t('sha256Fingerprint')}
          </Text>
          <View
            style={[
              styles.fingerprintCard,
              { backgroundColor: colors.background },
            ]}
          >
            <Text
              style={[styles.fingerprintValue, { color: colors.textPrimary }]}
              selectable
            >
              {certInfo.sha256Fingerprint}
            </Text>
          </View>

          {/* Action Buttons */}
          <Pressable
            style={({ pressed }) => [
              styles.trustButton,
              {
                backgroundColor: isRotation ? colors.red : isManualAdd && certInfo.isSystemTrusted ? colors.primary : colors.orange,
              },
              pressed && styles.buttonPressed,
            ]}
            onPress={handleTrust}
          >
            <Ionicons
              name="shield-checkmark-outline"
              size={20}
              color="#FFFFFF"
              style={styles.buttonIcon}
            />
            <Text style={styles.trustButtonText}>
              {isRotation
                ? t('trustNewCertificate')
                : t('trustThisCertificate')}
            </Text>
          </Pressable>

          <Pressable
            style={({ pressed }) => [
              styles.cancelButton,
              { borderColor: colors.border },
              pressed && styles.buttonPressed,
            ]}
            onPress={handleCancel}
          >
            <Text style={[styles.cancelButtonText, { color: colors.textPrimary }]}>
              {t('cancel')}
            </Text>
          </Pressable>
        </View>
    </BottomSheet>
  );
});

// --- Detail Row sub-component ---

interface DetailRowProps {
  label: string;
  value: string;
  colors: { textPrimary: string; textSecondary: string };
  mono?: boolean;
}

function DetailRow({ label, value, colors, mono }: DetailRowProps) {
  return (
    <View style={styles.detailRow}>
      <Text style={[styles.detailLabel, { color: colors.textSecondary }]}>
        {label}
      </Text>
      <Text
        style={[
          styles.detailValue,
          { color: colors.textPrimary },
          mono && styles.mono,
        ]}
        numberOfLines={2}
        selectable
      >
        {value}
      </Text>
    </View>
  );
}

// --- Helpers ---

function formatDate(isoString: string): string {
  if (isoString === 'Unknown') return isoString;
  try {
    const date = new Date(isoString);
    return date.toLocaleDateString(i18next.language, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return isoString;
  }
}

// --- Styles ---

const styles = StyleSheet.create({
  content: {
    paddingHorizontal: 20,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
    marginTop: 8,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
  },
  warning: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 16,
    fontWeight: '500',
  },
  description: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 16,
  },
  detailsCard: {
    borderRadius: 10,
    padding: 12,
    marginBottom: 16,
    gap: 8,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  detailLabel: {
    fontSize: 12,
    fontWeight: '500',
    width: 80,
    flexShrink: 0,
  },
  detailValue: {
    fontSize: 12,
    flex: 1,
    textAlign: 'right',
  },
  mono: {
    fontFamily: 'monospace',
    fontSize: 12,
  },
  fingerprintLabel: {
    fontSize: 12,
    fontWeight: '500',
    marginBottom: 6,
  },
  fingerprintCard: {
    borderRadius: 10,
    padding: 12,
    marginBottom: 20,
  },
  fingerprintValue: {
    fontFamily: 'monospace',
    fontSize: 12,
    lineHeight: 18,
  },
  trustButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    paddingVertical: 14,
    marginBottom: 10,
  },
  buttonIcon: {
    marginRight: 8,
  },
  trustButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  cancelButton: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    paddingVertical: 14,
    borderWidth: 1,
    marginBottom: 8,
  },
  cancelButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  buttonPressed: {
    opacity: 0.8,
  },
});
