/**
 * DEV-only Phase-0 spike runner. Reachable from Settings → Developer → "DB spikes"
 * (dev options must be enabled). Runs the persistence-rebuild de-risking spikes and
 * shows their output inline (shareable as a text file). Delete with `dbSpikes.ts`
 * and the Spike C screen once Phase 0 exits.
 */
import Ionicons from '@react-native-vector-icons/ionicons/static';
import { File, Paths } from 'expo-file-system';
import { useRouter } from 'expo-router';
import { HeaderHeightContext } from 'expo-router/react-navigation';
import { shareAsync } from 'expo-sharing';
import { useCallback, useContext, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { BottomChrome } from '../components/BottomChrome';
import { GradientBackground } from '../components/GradientBackground';
import { runSpikeA, runSpikeB } from '../db/testing/dbSpikes';
import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../constants/theme';
import type { IoniconsName } from '../utils/iconNames';

function SpikeButton({
  label,
  icon,
  onPress,
  disabled,
  colors,
}: {
  label: string;
  icon: IoniconsName;
  onPress: () => void;
  disabled?: boolean;
  colors: ThemeColors;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        { borderColor: colors.border, backgroundColor: colors.card },
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      <Ionicons name={icon} size={18} color={colors.primary} />
      <Text style={[styles.buttonText, { color: colors.primary }]}>{label}</Text>
    </Pressable>
  );
}

export function DbSpikesScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const headerHeight = useContext(HeaderHeightContext) ?? 0;
  const [lines, setLines] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  const log = useCallback((message: string) => {
    setLines((prev) => [...prev, message]);
  }, []);

  const run = useCallback(
    async (fn: (l: (m: string) => void) => Promise<void>) => {
      if (running) return;
      setRunning(true);
      try {
        await fn(log);
      } catch (e) {
        log(`UNCAUGHT: ${String(e)}`);
      } finally {
        log('');
        setRunning(false);
      }
    },
    [running, log],
  );

  const clear = useCallback(() => setLines([]), []);

  const share = useCallback(async () => {
    const file = new File(Paths.document, 'db-spikes.log');
    file.write(lines.join('\n'));
    await shareAsync(file.uri, { mimeType: 'text/plain' });
  }, [lines]);

  return (
    <GradientBackground>
      {/* Fixed control bar — stays put so Share/Clear never scroll out of reach. */}
      <View style={[styles.controls, { paddingTop: headerHeight + 12, borderBottomColor: colors.border }]}>
        <View style={styles.buttonRow}>
          <SpikeButton label="Run Spike A" icon="folder-open-outline" onPress={() => run(runSpikeA)} disabled={running} colors={colors} />
          <SpikeButton label="Run Spike B" icon="pulse-outline" onPress={() => run(runSpikeB)} disabled={running} colors={colors} />
        </View>
        <View style={styles.buttonRow}>
          <SpikeButton label="Spike C (UI)" icon="list-outline" onPress={() => router.push('/db-spike-c' as never)} disabled={running} colors={colors} />
          <SpikeButton label="Share" icon="share-outline" onPress={share} disabled={lines.length === 0} colors={colors} />
          <SpikeButton label="Clear" icon="trash-outline" onPress={clear} disabled={lines.length === 0 || running} colors={colors} />
        </View>
        {running && (
          <View style={styles.runningRow}>
            <ActivityIndicator color={colors.primary} />
            <Text style={[styles.runningText, { color: colors.textSecondary }]}>running…</Text>
          </View>
        )}
      </View>

      {/* Scrollable log below the fixed bar. Auto-scrolls to the end only while a
          spike is running, so once it finishes you can scroll the output freely. */}
      <ScrollView
        ref={scrollRef}
        style={styles.logScroll}
        contentContainerStyle={styles.logContent}
        onContentSizeChange={() => {
          if (running) scrollRef.current?.scrollToEnd({ animated: true });
        }}
        showsVerticalScrollIndicator
      >
        {lines.length === 0 ? (
          <Text style={[styles.placeholder, { color: colors.textSecondary }]}>
            No output yet. Run Spike A (open existing DB) or Spike B (contention + reactive).
          </Text>
        ) : (
          <View style={[styles.logPanel, { backgroundColor: colors.card, borderColor: colors.border }]}>
            {lines.map((line, i) => (
              <Text key={i} selectable style={[styles.logLine, { color: colors.textPrimary }]}>
                {line || ' '}
              </Text>
            ))}
          </View>
        )}
      </ScrollView>
      <BottomChrome />
    </GradientBackground>
  );
}

const styles = StyleSheet.create({
  controls: {
    paddingHorizontal: 16,
    paddingBottom: 12,
    gap: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  logScroll: { flex: 1 },
  logContent: { paddingHorizontal: 16, paddingVertical: 12, paddingBottom: 140 },
  buttonRow: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    flexGrow: 1,
    justifyContent: 'center',
  },
  buttonText: { fontSize: 15, fontWeight: '600' },
  pressed: { opacity: 0.6 },
  disabled: { opacity: 0.4 },
  runningRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  runningText: { fontSize: 13 },
  logPanel: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 12, gap: 2 },
  placeholder: { fontSize: 14, fontStyle: 'italic' },
  logLine: { fontSize: 12, fontFamily: 'monospace', lineHeight: 17 },
});
