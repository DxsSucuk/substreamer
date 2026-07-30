/**
 * DEV-only Phase-0/2 spike runner. Reachable from Settings → Developer → "DB spikes"
 * (dev options must be enabled). Pick a spike from the dropdown, Run it, and read
 * the output (shareable as a text file). Delete with `dbSpikes.ts` + the Spike C
 * screen once the persistence rebuild is done.
 */
import Ionicons from '@react-native-vector-icons/ionicons/static';
import { File, Paths } from 'expo-file-system';
import { Stack, useRouter } from 'expo-router';
import { shareAsync } from 'expo-sharing';
import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BottomChrome } from '../components/BottomChrome';
import { GradientBackground } from '../components/GradientBackground';
import { runSpikeA, runSpikeB, runSpikeD, runSpikeE, runSpikeF, runSpikeG, runSpikeH, runSpikeI, runSpikeJ } from '../db/testing/dbSpikes';
import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../constants/theme';
import type { IoniconsName } from '../utils/iconNames';

type Runner = (log: (message: string) => void) => Promise<void>;
type SpikeKey = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J';

interface SpikeDef {
  key: SpikeKey;
  label: string;
  icon: IoniconsName;
  run?: Runner; // a loggable spike
  nav?: string; // or a screen to open (Spike C is interactive)
}

const SPIKES: SpikeDef[] = [
  { key: 'I', label: 'I · full sync FAST (search3)', icon: 'cloud-download-outline', run: runSpikeI },
  { key: 'J', label: 'J · full sync SLOW (basic walk)', icon: 'speedometer-outline', run: runSpikeJ },
  { key: 'D', label: 'D · migrate cold + timed', icon: 'git-branch-outline', run: runSpikeD },
  { key: 'E', label: 'E · remote sync timing', icon: 'cloud-download-outline', run: runSpikeE },
  { key: 'F', label: 'F · search-derive split', icon: 'search-outline', run: runSpikeF },
  { key: 'G', label: 'G · infix LIKE vs scale', icon: 'speedometer-outline', run: runSpikeG },
  { key: 'H', label: 'H · reset normalized (boot-migrate test)', icon: 'refresh-outline', run: runSpikeH },
  { key: 'A', label: 'A · open existing DB', icon: 'folder-open-outline', run: runSpikeA },
  { key: 'B', label: 'B · contention + reactive', icon: 'pulse-outline', run: runSpikeB },
  { key: 'C', label: 'C · FlashList keyset (UI)', icon: 'list-outline', nav: '/db-spike-c' },
];

function IconBtn({
  icon,
  onPress,
  disabled,
  colors,
}: {
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
        styles.iconBtn,
        { borderColor: colors.border, backgroundColor: colors.card },
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      <Ionicons name={icon} size={18} color={colors.primary} />
    </Pressable>
  );
}

export function DbSpikesScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [lines, setLines] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [selectedKey, setSelectedKey] = useState<SpikeKey>('D');
  const [menuOpen, setMenuOpen] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  const selected = useMemo(() => SPIKES.find((s) => s.key === selectedKey)!, [selectedKey]);

  const log = useCallback((message: string) => setLines((prev) => [...prev, message]), []);

  const run = useCallback(
    async (fn: Runner) => {
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

  const onRun = useCallback(() => {
    setMenuOpen(false);
    if (selected.nav) router.push(selected.nav as never);
    else if (selected.run) void run(selected.run);
  }, [selected, router, run]);

  const clear = useCallback(() => setLines([]), []);
  const share = useCallback(async () => {
    const file = new File(Paths.document, 'db-spikes.log');
    file.write(lines.join('\n'));
    await shareAsync(file.uri, { mimeType: 'text/plain' });
  }, [lines]);

  return (
    <GradientBackground scrollable>
      {/* Dev screen: hide the nav header entirely so the controls sit at the very
          top (no reserved header band) and the results get the rest of the screen. */}
      <Stack.Screen options={{ headerShown: false }} />
      {/* Compact control bar pinned to the safe-area top. */}
      <View style={[styles.controls, { paddingTop: insets.top + 8, borderBottomColor: colors.border }]}>
        {/* Row 1: back + the selection dropdown (flexes to stay readable). */}
        <View style={styles.controlRow}>
          <IconBtn icon="chevron-back" onPress={() => router.back()} colors={colors} />
          <Pressable
            onPress={() => setMenuOpen((o) => !o)}
            style={[styles.dropdown, { flex: 1, borderColor: colors.border, backgroundColor: colors.card }]}
          >
            <Ionicons name={selected.icon} size={16} color={colors.primary} />
            <Text style={[styles.dropdownText, { color: colors.textPrimary }]} numberOfLines={1}>
              {selected.label}
            </Text>
            <Ionicons name={menuOpen ? 'chevron-up' : 'chevron-down'} size={16} color={colors.textSecondary} />
          </Pressable>
        </View>

        {menuOpen && (
          <View style={[styles.menu, { borderColor: colors.border, backgroundColor: colors.card }]}>
            {SPIKES.map((s) => {
              const active = s.key === selectedKey;
              return (
                <Pressable
                  key={s.key}
                  onPress={() => {
                    setSelectedKey(s.key);
                    setMenuOpen(false);
                  }}
                  style={({ pressed }) => [styles.menuItem, pressed && styles.pressed]}
                >
                  <Ionicons name={s.icon} size={16} color={active ? colors.primary : colors.textSecondary} />
                  <Text style={[styles.menuText, { color: active ? colors.primary : colors.textPrimary }]}>
                    {s.label}
                  </Text>
                  {active && <Ionicons name="checkmark" size={16} color={colors.primary} />}
                </Pressable>
              );
            })}
          </View>
        )}

        {/* Actions row, under the dropdown. */}
        <View style={styles.controlRow}>
          <Pressable
            onPress={onRun}
            disabled={running}
            style={({ pressed }) => [
              styles.runBtn,
              { backgroundColor: colors.primary },
              pressed && styles.pressed,
              running && styles.disabled,
            ]}
          >
            {running ? (
              <ActivityIndicator size="small" color={colors.background} />
            ) : (
              <Ionicons name={selected.nav ? 'open-outline' : 'play'} size={16} color={colors.background} />
            )}
            <Text style={[styles.runText, { color: colors.background }]}>{selected.nav ? 'Open' : 'Run'}</Text>
          </Pressable>
          <IconBtn icon="share-outline" onPress={share} disabled={lines.length === 0} colors={colors} />
          <IconBtn icon="trash-outline" onPress={clear} disabled={lines.length === 0 || running} colors={colors} />
        </View>
      </View>

      {/* Results — fills the remaining space; auto-scrolls to the end while running. */}
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
            Pick a spike above and tap Run. Output appears here.
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
    // paddingTop is applied inline from the safe-area inset (header is hidden).
    paddingHorizontal: 12,
    paddingBottom: 10,
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    zIndex: 10,
  },
  controlRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dropdown: {
    height: 46,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  dropdownText: { flex: 1, fontSize: 15, fontWeight: '600' },
  runBtn: {
    flex: 1,
    height: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: 10,
  },
  runText: { fontSize: 15, fontWeight: '700' },
  iconBtn: {
    width: 50,
    height: 46,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  menu: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, overflow: 'hidden' },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, paddingHorizontal: 12 },
  menuText: { flex: 1, fontSize: 14 },
  pressed: { opacity: 0.6 },
  disabled: { opacity: 0.4 },
  logScroll: { flex: 1 },
  logContent: { paddingHorizontal: 12, paddingVertical: 10, paddingBottom: 140 },
  logPanel: { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, padding: 12, gap: 2 },
  placeholder: { fontSize: 14, fontStyle: 'italic' },
  logLine: { fontSize: 12, fontFamily: 'monospace', lineHeight: 17 },
});
