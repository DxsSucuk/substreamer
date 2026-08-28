import MaterialCommunityIcons from '@react-native-vector-icons/material-design-icons/static';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Cast, useAudioRoute } from 'react-native-queue-player';

import { BottomSheet } from '../BottomSheet';
import {
  CAST_ACTIVE_LOCAL_SUBTITLE,
  SHEET_TITLE,
  SYSTEM_ROUTE_ACTIVE_LOCAL_SUBTITLE,
} from './copy';
import { RouteRow } from './RouteRow';
import { type RouteInfo, type RoutePickerTheme } from './types';
import { useRouteDiscovery } from './useRouteDiscovery';
import { useRoutePickerStore } from './useRoutePickerStore';
import { useRoutePickerTheme } from './useRoutePickerTheme';

/**
 * How long the picker stays open after a successful connect so the newly active
 * route's highlight paints before dismissal.
 */
const ACTIVE_HIGHLIGHT_HOLD_MS = 600;

export interface RoutePickerSheetProps {
  /** Optional theme override; falls back to the app theme. */
  theme?: Partial<RoutePickerTheme>;
}

/**
 * Audio route picker bottom sheet. Mounts once at the root layout (self-
 * contained, like the app's other global sheets); any screen opens it via
 * `useRoutePickerStore().open()`. Discovery lives in an inner component so it
 * only runs while the sheet is open (our BottomSheet unmounts its children when
 * hidden). PIN entry for AirPlay pairing is inline; the sheet lifts above the
 * keyboard via the shared BottomSheet.
 */
export function RoutePickerSheet({ theme }: RoutePickerSheetProps = {}) {
  const t = useRoutePickerTheme(theme);
  const isOpen = useRoutePickerStore((s) => s.isOpen);
  const close = useRoutePickerStore((s) => s.close);
  return (
    <BottomSheet visible={isOpen} onClose={close} maxHeight="75%">
      {isOpen && <RoutePickerContent theme={t} onClose={close} />}
    </BottomSheet>
  );
}

function RoutePickerContent({ theme: t, onClose }: { theme: RoutePickerTheme; onClose: () => void }) {
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    },
    [],
  );

  const { routes, state, connect, disconnect } = useRouteDiscovery();
  const audioRoute = useAudioRoute();

  // iOS AirPlay / Bluetooth are OS-managed — they surface as the system audio
  // route, not a discovered receiver. The "AirPlay & Bluetooth" row stands in
  // for exactly those.
  const systemRouteActive =
    Platform.OS === 'ios' &&
    (audioRoute.kind === 'airplay' || audioRoute.kind.startsWith('bluetooth'));

  // On iOS, hide non-active AirPlay rows (they belong to the system picker
  // delegate row). The active AirPlay row stays so there's an in-sheet
  // disconnect target.
  const visibleRoutes = useMemo(
    () =>
      Platform.OS === 'ios'
        ? routes.filter((r) => r.protocol !== 'airplay' || r.isActive)
        : routes,
    [routes],
  );

  const localRoute = visibleRoutes[0];
  const effectiveLocalRoute =
    localRoute && systemRouteActive ? { ...localRoute, isActive: false } : localRoute;
  const discoveredRoutes = visibleRoutes.slice(1);
  const renderedRoutes = effectiveLocalRoute
    ? [effectiveLocalRoute, ...discoveredRoutes]
    : discoveredRoutes;
  const showSearching = state === 'scanning' && discoveredRoutes.length === 0;

  const handleConnect = useCallback(
    (id: string, password?: string) => {
      connect(id, password)
        .then(() => {
          // Route is live + the row is marked active. Hold so its highlight
          // paints, then dismiss (which stops discovery via unmount).
          if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
          closeTimerRef.current = setTimeout(onClose, ACTIVE_HIGHLIGHT_HOLD_MS);
        })
        .catch((err: unknown) => {
          const code =
            err && typeof err === 'object' && 'code' in err
              ? (err as { code: unknown }).code
              : undefined;
          const isExpected =
            code === Cast.CastErrorCodes.AUTH_REQUIRED ||
            code === Cast.CastErrorCodes.CONNECT_FAILED;
          if (!isExpected) {
            // eslint-disable-next-line no-console
            console.warn('[RoutePicker] connect failed with unknown code', err);
          }
        });
    },
    [connect, onClose],
  );

  return (
    <View>
      <View style={styles.header}>
        <Text style={[styles.headerKicker, { color: t.textSubtle }]}>{SHEET_TITLE}</Text>
      </View>
      <View>
        {renderedRoutes.map((r, idx) => (
          <View key={routeKey(r)}>
            <RouteRow
              route={r}
              subtitleOverride={localSubtitleOverride(r, systemRouteActive)}
              onConnect={handleConnect}
              onDisconnect={() => void disconnect()}
              theme={t}
            />
            {Platform.OS === 'ios' && idx === 0 && (
              <SystemPickerRow theme={t} active={systemRouteActive} routeName={audioRoute.name} />
            )}
          </View>
        ))}
      </View>
      {showSearching && (
        <View style={styles.empty}>
          <Text style={{ color: t.textSubtle }}>Looking for nearby devices…</Text>
        </View>
      )}
      {state === 'permission-denied' && (
        <View style={styles.empty}>
          <Text style={{ color: t.errorIndicator, fontWeight: '600' }}>
            Local Network access denied
          </Text>
          <Text style={{ color: t.textSubtle, fontSize: 12, marginTop: 4 }}>
            Open Settings to grant Local Network for this app.
          </Text>
        </View>
      )}
      {state === 'error' && (
        <View style={styles.empty}>
          <Text style={{ color: t.errorIndicator, fontSize: 12 }}>Cast unavailable on this build</Text>
        </View>
      )}
    </View>
  );
}

function routeKey(r: RouteInfo): string {
  return r.id.length === 0 ? 'local' : r.id;
}

function localSubtitleOverride(route: RouteInfo, systemRouteActive: boolean): string | undefined {
  if (route.protocol !== 'local') return undefined;
  if (systemRouteActive) return SYSTEM_ROUTE_ACTIVE_LOCAL_SUBTITLE;
  if (!route.isActive) return CAST_ACTIVE_LOCAL_SUBTITLE;
  return undefined;
}

/** iOS-only delegate row: opens Apple's system route picker (AirPlay/BT/wired). */
function SystemPickerRow({
  theme,
  active,
  routeName,
}: {
  theme: RoutePickerTheme;
  active: boolean;
  routeName: string;
}) {
  const subtitle = active && routeName.length > 0 ? routeName : 'Open system picker';
  return (
    <Pressable
      testID="route-row-system-picker"
      onPress={() => {
        void Cast.showSystemPicker().catch(() => {});
      }}
      accessibilityRole="button"
      accessibilityLabel="Open AirPlay and Bluetooth device picker"
      accessibilityState={{ selected: active }}
      style={({ pressed }) => [
        styles.row,
        { borderBottomColor: theme.border },
        pressed && { backgroundColor: theme.surface },
      ]}
    >
      <View style={[styles.iconBox, { backgroundColor: theme.surface }]}>
        <MaterialCommunityIcons name="cast-audio" size={22} color={active ? theme.accent : theme.text} />
      </View>
      <View style={styles.labelStack}>
        <Text style={{ color: theme.text, fontSize: 15, fontWeight: '600' }} numberOfLines={1}>
          AirPlay & Bluetooth
        </Text>
        <Text style={{ color: theme.textSubtle, fontSize: 12 }} numberOfLines={1}>
          {subtitle}
        </Text>
      </View>
      <View style={styles.accessory}>
        {active ? (
          <MaterialCommunityIcons name="check-circle" size={20} color={theme.activeIndicator} />
        ) : (
          <MaterialCommunityIcons name="chevron-right" size={22} color={theme.textSubtle} />
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  headerKicker: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  empty: { padding: 32, alignItems: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  iconBox: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  labelStack: { flex: 1, gap: 2 },
  accessory: { width: 28, alignItems: 'center', justifyContent: 'center' },
});
