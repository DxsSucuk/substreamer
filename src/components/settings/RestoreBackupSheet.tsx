import Ionicons from '@react-native-vector-icons/ionicons/static';
import i18next from 'i18next';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { useTheme } from '../../hooks/useTheme';
import { useThemedAlert } from '../../hooks/useThemedAlert';
import { settingsStyles } from '../../styles/settingsStyles';
import {
  listBackups,
  restoreBackup,
  type BackupEntry,
} from '../../services/backupService';
import { authStore } from '../../store/authStore';
import { deviceIdentityStore } from '../../store/deviceIdentityStore';
import { formatBytes } from '../../utils/formatters';
import { minDelay } from '../../utils/stringHelpers';

const MIN_SPINNER_MS = 600;
const SUCCESS_DELAY_MS = 600;
const ERROR_DELAY_MS = 2000;

type RestoreState = 'idle' | 'restoring' | 'success' | 'error';

export function RestoreBackupSheet({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { alert, confirm } = useThemedAlert();
  const insets = useSafeAreaInsets();
  const localDeviceId = deviceIdentityStore((s) => s.deviceId);

  const [currentList, setCurrentList] = useState<BackupEntry[]>([]);
  const [otherList, setOtherList] = useState<BackupEntry[]>([]);
  const [otherExpanded, setOtherExpanded] = useState(false);
  const [selected, setSelected] = useState<BackupEntry | null>(null);
  const [state, setState] = useState<RestoreState>('idle');
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const chevronRotation = useSharedValue(0);
  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${chevronRotation.value}deg` }],
  }));

  useEffect(() => {
    if (!visible) return;
    (async () => {
      const { serverUrl, username } = authStore.getState();
      const result = serverUrl && username
        ? await listBackups({ serverUrl, username })
        : await listBackups();
      setCurrentList(result.current);
      setOtherList(result.other);
      setSelected(null);
      setState('idle');
      setOtherExpanded(false);
      chevronRotation.value = 0;
    })();
  }, [visible, chevronRotation]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const handleClose = useCallback(() => {
    if (state === 'restoring') return;
    if (timerRef.current) clearTimeout(timerRef.current);
    setCurrentList([]);
    setOtherList([]);
    setSelected(null);
    setState('idle');
    onClose();
  }, [state, onClose]);

  const handleSelect = useCallback((entry: BackupEntry) => {
    if (state !== 'idle') return;
    setSelected((prev) => prev?.stem === entry.stem ? null : entry);
  }, [state]);

  const performRestore = useCallback(
    (entry: BackupEntry, mode: 'replace' | 'merge') => async () => {
      setState('restoring');
      const [result] = await Promise.allSettled([
        restoreBackup(entry, mode),
        minDelay(MIN_SPINNER_MS),
      ]);
      if (result.status === 'fulfilled') {
        setState('success');
        timerRef.current = setTimeout(() => {
          setCurrentList([]);
          setOtherList([]);
          setSelected(null);
          setState('idle');
          onClose();
        }, SUCCESS_DELAY_MS);
      } else {
        setState('error');
        timerRef.current = setTimeout(() => setState('idle'), ERROR_DELAY_MS);
      }
    },
    [onClose],
  );

  const handleRestore = useCallback(() => {
    if (!selected) return;
    if (state === 'error') {
      setState('idle');
      return;
    }
    if (timerRef.current) clearTimeout(timerRef.current);

    const entry = selected;
    const parts: string[] = [];
    if (entry.scrobbleCount > 0) {
      parts.push(t('backupScrobbleCount', { count: entry.scrobbleCount }));
    }
    if (entry.mbidOverrideCount > 0) {
      parts.push(t('backupMbidOverrideCount', { count: entry.mbidOverrideCount }));
    }
    if (entry.scrobbleExclusionCount > 0) {
      parts.push(t('backupExclusionCount', { count: entry.scrobbleExclusionCount }));
    }
    if (entry.bookmarkCount > 0) {
      parts.push(t('backupBookmarkCount', { count: entry.bookmarkCount }));
    }
    const dateStr = new Date(entry.createdAt).toLocaleString(i18next.language, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    const isCrossDevice = entry.deviceId !== null && entry.deviceId !== localDeviceId;

    if (isCrossDevice) {
      const deviceName = entry.deviceLabel ?? t('unknownDevice');
      alert(
        t('restoreCrossDeviceConfirm', { device: deviceName }),
        t('restoreCrossDeviceConfirmMessage', {
          device: deviceName,
          date: dateStr,
          details: parts.join(', '),
        }),
        [
          { text: t('cancel'), style: 'cancel' },
          { text: t('restoreReplace'), style: 'destructive', onPress: performRestore(entry, 'replace') },
          { text: t('restoreMerge'), onPress: performRestore(entry, 'merge') },
        ],
      );
      return;
    }

    confirm({
      title: t('restoreBackupConfirm'),
      message: t('restoreBackupConfirmMessage', { date: dateStr, details: parts.join(', ') }),
      confirmLabel: t('restore'),
      destructive: true,
      onConfirm: performRestore(entry, 'replace'),
    });
  }, [selected, state, localDeviceId, alert, confirm, t, performRestore]);

  function renderRow(entry: BackupEntry, includeServerUrl: boolean) {
    const isSelected = selected?.stem === entry.stem;
    const dateStr = new Date(entry.createdAt).toLocaleString(i18next.language, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    const details: string[] = [];
    if (entry.scrobbleCount > 0) {
      details.push(t('backupScrobbleCount', { count: entry.scrobbleCount }));
    }
    if (entry.mbidOverrideCount > 0) {
      details.push(t('backupMbidOverrideCount', { count: entry.mbidOverrideCount }));
    }
    if (entry.bookmarkCount > 0) {
      details.push(t('backupBookmarkCount', { count: entry.bookmarkCount }));
    }
    const totalBytes =
      entry.scrobbleSizeBytes + entry.mbidOverrideSizeBytes + entry.scrobbleExclusionSizeBytes
      + entry.bookmarkSizeBytes;
    return (
      <Pressable
        key={entry.stem}
        onPress={() => handleSelect(entry)}
        style={({ pressed }) => [
          styles.row,
          { borderBottomColor: colors.border },
          isSelected && { borderLeftColor: colors.primary, borderLeftWidth: 3 },
          pressed && styles.rowPressed,
        ]}
      >
        <View style={styles.rowTitleLine}>
          <Text
            style={[
              styles.rowTitle,
              { color: colors.textPrimary },
              isSelected && { color: colors.primary },
            ]}
          >
            {dateStr}
          </Text>
          {entry.deviceId === localDeviceId && (
            <View style={[styles.badge, { backgroundColor: colors.primary + '22', borderColor: colors.primary }]}>
              <Text style={[styles.badgeText, { color: colors.primary }]}>{t('thisDevice')}</Text>
            </View>
          )}
        </View>
        <Text style={[styles.rowDevice, { color: colors.textSecondary }]}>
          {entry.deviceLabel ?? t('unknownDevice')}
        </Text>
        <Text style={[styles.rowDetail, { color: colors.textSecondary }]}>
          {details.join(', ')} · {formatBytes(totalBytes)}
        </Text>
        {includeServerUrl && entry.serverUrl && (
          <Text style={[styles.rowServer, { color: colors.label }]}>{entry.serverUrl}</Text>
        )}
      </Pressable>
    );
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={handleClose}
    >
      <Pressable style={settingsStyles.sheetBackdrop} onPress={handleClose} />
      <View
        style={[
          settingsStyles.sheet,
          { backgroundColor: colors.card, paddingBottom: Math.max(insets.bottom, 16) },
        ]}
      >
        <View style={[settingsStyles.sheetHandle, { backgroundColor: colors.border }]} />
        <Text style={[styles.title, { color: colors.textPrimary }]}>{t('restoreBackup')}</Text>
        <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
          {t('restoreBackupHint')}
        </Text>
        {currentList.length === 0 && otherList.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons name="cloud-offline-outline" size={32} color={colors.primary} />
            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
              {t('noBackupsAvailable')}
            </Text>
          </View>
        ) : (
          <>
            {currentList.map((entry) => renderRow(entry, false))}

            {otherList.length > 0 && (
              <>
                <Pressable
                  onPress={() => {
                    setOtherExpanded((prev) => {
                      chevronRotation.value = withTiming(prev ? 0 : 90, { duration: 200 });
                      return !prev;
                    });
                  }}
                  style={[styles.otherHeader, { borderBottomColor: colors.border }]}
                >
                  <Text style={[styles.otherTitle, { color: colors.textSecondary }]}>
                    {t('otherBackups')}
                  </Text>
                  <Animated.View style={chevronStyle}>
                    <Ionicons name="chevron-forward" size={16} color={colors.textSecondary} />
                  </Animated.View>
                </Pressable>
                {otherExpanded && otherList.map((entry) => renderRow(entry, true))}
              </>
            )}

            <View style={styles.actions}>
              <Pressable
                onPress={handleRestore}
                disabled={!selected || state === 'restoring' || state === 'success'}
                style={({ pressed }) => [
                  styles.restoreButton,
                  state === 'success'
                    ? { backgroundColor: colors.green }
                    : state === 'error'
                      ? { backgroundColor: colors.red }
                      : { backgroundColor: colors.primary },
                  pressed && state === 'idle' && selected && settingsStyles.pressed,
                  (!selected && state === 'idle') && settingsStyles.disabled,
                ]}
              >
                {state === 'restoring' ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : state === 'success' ? (
                  <Ionicons name="checkmark" size={20} color="#fff" />
                ) : state === 'error' ? (
                  <View style={styles.errorContent}>
                    <Ionicons name="alert-circle" size={20} color="#fff" />
                    <Text style={styles.restoreButtonText}>
                      {t('failedToRestoreTapToRetry')}
                    </Text>
                  </View>
                ) : (
                  <Text style={styles.restoreButtonText}>{t('restore')}</Text>
                )}
              </Pressable>
            </View>
          </>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  title: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 4,
    paddingHorizontal: 4,
  },
  subtitle: {
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 16,
    paddingHorizontal: 4,
  },
  empty: {
    alignItems: 'center',
    paddingVertical: 32,
    gap: 12,
  },
  emptyText: { fontSize: 15 },
  row: {
    paddingVertical: 12,
    paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: 0,
  },
  rowPressed: { opacity: 0.7 },
  rowTitleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  rowTitle: { fontSize: 16, fontWeight: '600' },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
  },
  badgeText: { fontSize: 11, fontWeight: '600' },
  rowDevice: { fontSize: 13, marginBottom: 2 },
  rowDetail: { fontSize: 12 },
  rowServer: { fontSize: 11, marginTop: 4, fontFamily: 'monospace' },
  otherHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  otherTitle: { fontSize: 13, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  actions: { marginTop: 16, paddingHorizontal: 4 },
  restoreButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 12,
    paddingVertical: 14,
  },
  restoreButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  errorContent: { flexDirection: 'row', alignItems: 'center', gap: 6 },
});
