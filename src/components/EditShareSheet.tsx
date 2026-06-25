import Ionicons from "@react-native-vector-icons/ionicons/static";
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useTranslation } from 'react-i18next';

import { BottomSheet } from './BottomSheet';
import { CachedImage } from './CachedImage';
import { resolveSongCoverArt } from '../hooks/useSongCoverArt';
import { useTheme } from '../hooks/useTheme';
import { updateShare } from '../services/subsonicService';
import { editShareStore } from '../store/editShareStore';
import { sharesStore } from '../store/sharesStore';

const EXPIRATION_OPTIONS = [
  { labelKey: 'expiresNever', days: null },
  { labelKey: 'expires1Day', days: 1 },
  { labelKey: 'expires7Days', days: 7 },
  { labelKey: 'expires30Days', days: 30 },
  { labelKey: 'expires90Days', days: 90 },
  { labelKey: 'expires1Year', days: 365 },
] as const;

type ExpirationDays = (typeof EXPIRATION_OPTIONS)[number]['days'];

function expirationToTimestamp(days: ExpirationDays): number | undefined {
  if (days == null) return undefined;
  return Date.now() + days * 24 * 60 * 60 * 1000;
}

function closestExpirationOption(expires: Date | string | undefined): ExpirationDays {
  if (!expires) return null;
  const d = typeof expires === 'string' ? new Date(expires) : expires;
  if (isNaN(d.getTime())) return null;
  const diff = d.getTime() - Date.now();
  if (diff <= 0) return null;
  const days = diff / (24 * 60 * 60 * 1000);
  if (days <= 1.5) return 1;
  if (days <= 10) return 7;
  if (days <= 60) return 30;
  if (days <= 180) return 90;
  return 365;
}

export function EditShareSheet() {
  const visible = editShareStore((s) => s.visible);
  const share = editShareStore((s) => s.share);
  const hide = editShareStore((s) => s.hide);

  const { colors } = useTheme();
  const { t } = useTranslation();

  const [description, setDescription] = useState('');
  const [selectedExpiration, setSelectedExpiration] = useState<ExpirationDays>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (share) {
      setDescription(share.description ?? '');
      setSelectedExpiration(closestExpirationOption(share.expires));
      setError(null);
    }
  }, [share]);

  const handleClose = useCallback(() => {
    hide();
    setDescription('');
    setSelectedExpiration(null);
    setSaving(false);
    setError(null);
  }, [hide]);

  const handleSave = useCallback(async () => {
    if (!share) return;
    setSaving(true);
    setError(null);

    const expires = expirationToTimestamp(selectedExpiration);
    const desc = description.trim();

    const success = await updateShare(share.id, desc, expires);
    setSaving(false);

    if (success) {
      sharesStore.getState().fetchShares();
      handleClose();
    } else {
      setError(t('failedToUpdateShare'));
    }
  }, [share, description, selectedExpiration, handleClose]);

  const dynamicStyles = useMemo(
    () =>
      StyleSheet.create({
        title: { color: colors.textPrimary },
        subtitle: { color: colors.textSecondary },
        label: { color: colors.textSecondary },
        input: {
          backgroundColor: colors.inputBg,
          color: colors.textPrimary,
          borderColor: colors.border,
        },
        chipSelected: { backgroundColor: colors.primary },
        chipDefault: {
          backgroundColor: colors.inputBg,
          borderColor: colors.border,
        },
        chipTextSelected: { color: '#fff' },
        chipTextDefault: { color: colors.textPrimary },
        saveButton: { backgroundColor: colors.primary },
        errorText: { color: colors.red },
      }),
    [colors],
  );

  const shareTitle = useMemo(() => {
    if (!share) return '';
    if (share.description) return share.description;
    const entries = share.entry ?? [];
    if (entries.length > 0) {
      const first = entries[0].title ?? entries[0].album ?? t('sharedItems');
      return entries.length > 1 ? `${first} + ${entries.length - 1} more` : first;
    }
    return t('share');
  }, [share, t]);

  // `coverArt`-value based cover art (see src/utils/coverArtId.ts). (#202)
  // Share's first entry is a song-level Child; resolve its song cover.
  const firstEntry = share?.entry?.[0];
  const coverArtId = firstEntry ? resolveSongCoverArt(firstEntry) : undefined;

  return (
    <BottomSheet visible={visible} onClose={handleClose}>
      <View style={styles.header}>
        {coverArtId && (
          <CachedImage coverArtId={coverArtId} size={150} style={styles.coverArt} resizeMode="cover" />
        )}
        <View style={styles.headerText}>
          <Text style={[styles.title, dynamicStyles.title]} numberOfLines={1}>
            {t('editShare')}
          </Text>
          <Text style={[styles.subtitle, dynamicStyles.subtitle]} numberOfLines={1}>
            {shareTitle}
          </Text>
        </View>
      </View>

        <View style={styles.formSection}>
          <Text style={[styles.label, dynamicStyles.label]}>{t('description')}</Text>
          <TextInput
            style={[styles.input, dynamicStyles.input]}
            value={description}
            onChangeText={setDescription}
            placeholder={t('addANotePlaceholder')}
            placeholderTextColor={colors.textSecondary}
            returnKeyType="done"
            editable={!saving}
          />

          <Text style={[styles.label, dynamicStyles.label, styles.expirationLabel]}>
            {t('expires')}
          </Text>
          <View style={styles.chipRow}>
            {EXPIRATION_OPTIONS.map((opt) => {
              const selected = selectedExpiration === opt.days;
              return (
                <Pressable
                  key={opt.labelKey}
                  onPress={() => setSelectedExpiration(opt.days)}
                  disabled={saving}
                  style={[
                    styles.chip,
                    selected ? dynamicStyles.chipSelected : dynamicStyles.chipDefault,
                    !selected && styles.chipBorder,
                  ]}
                >
                  <Text
                    style={[
                      styles.chipText,
                      selected ? dynamicStyles.chipTextSelected : dynamicStyles.chipTextDefault,
                    ]}
                  >
                    {t(opt.labelKey)}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {error && (
            <Text style={[styles.errorText, dynamicStyles.errorText]}>{error}</Text>
          )}

          <Pressable
            onPress={handleSave}
            disabled={saving}
            style={({ pressed }) => [
              styles.saveButton,
              dynamicStyles.saveButton,
              pressed && styles.buttonPressed,
              saving && styles.buttonDisabled,
            ]}
          >
            {saving ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <Ionicons name="checkmark" size={18} color="#fff" />
                <Text style={styles.saveButtonText}>{t('saveChanges')}</Text>
              </>
            )}
          </Pressable>

          <Pressable onPress={handleClose} style={styles.cancelButton}>
            <Text style={[styles.cancelButtonText, { color: colors.primary }]}>{t('cancel')}</Text>
          </Pressable>
        </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 4,
    marginBottom: 12,
  },
  coverArt: {
    width: 48,
    height: 48,
    borderRadius: 8,
    backgroundColor: 'rgba(128,128,128,0.12)',
    marginRight: 12,
  },
  headerText: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 2,
  },
  subtitle: {
    fontSize: 14,
    fontWeight: '400',
  },
  formSection: {
    paddingHorizontal: 4,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  expirationLabel: {
    marginTop: 16,
  },
  input: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
  },
  chipBorder: {
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipText: {
    fontSize: 14,
    fontWeight: '500',
  },
  errorText: {
    fontSize: 14,
    marginTop: 12,
  },
  saveButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 12,
    paddingVertical: 14,
    marginTop: 20,
    marginBottom: 8,
  },
  saveButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  buttonPressed: {
    opacity: 0.8,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  cancelButton: {
    alignItems: 'center',
    paddingVertical: 12,
    marginBottom: 4,
  },
  cancelButtonText: {
    fontSize: 16,
    fontWeight: '500',
  },
});
