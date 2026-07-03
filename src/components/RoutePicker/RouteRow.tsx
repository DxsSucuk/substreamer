import MaterialCommunityIcons from '@react-native-vector-icons/material-design-icons/static';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  localRouteDisplayName,
  rowSubtitle,
  startCastingA11yLabel,
  stopCastingA11yLabel,
} from './copy';
import { iconForRoute } from './iconForRoute';
import { type RouteInfo, type RoutePickerTheme } from './types';

export interface RouteRowProps {
  route: RouteInfo;
  /**
   * Fired on row tap. If the row's `lastError === 'cast_auth_required'`, the
   * row first expands an inline PIN/password field and only fires `onConnect`
   * after the user submits.
   */
  onConnect: (id: string, password?: string) => void;
  /** Fired on tap of the active row — disconnects. */
  onDisconnect: () => void;
  /** Replaces the derived protocol subtitle (used for the local row). */
  subtitleOverride?: string;
  theme: RoutePickerTheme;
}

/**
 * Single device row: icon + name + subtitle + trailing accessory (spinner /
 * check / error / chevron). Inline PIN expander for AirPlay pair auth so the
 * user doesn't leave the picker. The inline field is a plain TextInput — the
 * host BottomSheet lifts itself above the keyboard (see BottomSheet #209).
 */
export function RouteRow({ route, onConnect, onDisconnect, subtitleOverride, theme: t }: RouteRowProps) {
  const [pinExpanded, setPinExpanded] = useState(false);
  const [pin, setPin] = useState('');
  const [pinFocused, setPinFocused] = useState(false);

  useEffect(() => {
    if (route.lastError === 'cast_auth_required') {
      setPinExpanded(true);
    }
  }, [route.lastError]);

  const needsPair =
    route.lastError === 'cast_auth_required' || route.capabilities.requiresPairing;

  const handlePress = () => {
    if (route.isActive || route.protocol === 'local') {
      onDisconnect();
      return;
    }
    if (needsPair && !pinExpanded) {
      setPinExpanded(true);
      return;
    }
    onConnect(route.id, pinExpanded && pin.length > 0 ? pin : undefined);
  };

  const displayName =
    route.protocol === 'local'
      ? localRouteDisplayName()
      : route.name.length > 0
        ? route.name
        : localRouteDisplayName();

  return (
    <View>
      <Pressable
        testID={`route-row-${route.id || 'local'}`}
        onPress={handlePress}
        accessibilityRole="button"
        accessibilityLabel={
          route.isActive ? stopCastingA11yLabel(displayName) : startCastingA11yLabel(displayName)
        }
        style={({ pressed }) => [
          styles.row,
          { borderBottomColor: t.border },
          pressed && { backgroundColor: t.surface },
        ]}
      >
        <View style={[styles.iconBox, { backgroundColor: t.surface }]}>
          <MaterialCommunityIcons
            name={iconForRoute(route)}
            size={22}
            color={route.isActive ? t.accent : t.text}
          />
        </View>
        <View style={styles.labelStack}>
          <Text style={{ color: t.text, fontSize: 15, fontWeight: '600' }} numberOfLines={1}>
            {displayName}
          </Text>
          <Text style={{ color: t.textSubtle, fontSize: 12 }} numberOfLines={1}>
            {subtitleOverride ?? rowSubtitle(route)}
          </Text>
        </View>
        <View style={styles.accessory}>
          {route.isConnecting ? (
            <ActivityIndicator color={t.connectingIndicator} />
          ) : route.isActive ? (
            <MaterialCommunityIcons name="check-circle" size={20} color={t.activeIndicator} />
          ) : route.lastError ? (
            <MaterialCommunityIcons name="alert-circle-outline" size={20} color={t.errorIndicator} />
          ) : (
            <MaterialCommunityIcons name="chevron-right" size={22} color={t.textSubtle} />
          )}
        </View>
      </Pressable>
      {pinExpanded && !route.isActive && (
        <View style={[styles.pairRow, { backgroundColor: t.surface, borderBottomColor: t.border }]}>
          <TextInput
            testID={`route-row-${route.id || 'local'}-pin`}
            value={pin}
            onChangeText={setPin}
            onFocus={() => setPinFocused(true)}
            onBlur={() => setPinFocused(false)}
            placeholder="PIN or password"
            placeholderTextColor={t.textSubtle}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            style={[
              styles.pinInput,
              {
                color: t.text,
                backgroundColor: t.background,
                borderColor: pinFocused ? t.accent : t.border,
                borderWidth: pinFocused ? 1.5 : 1,
              },
            ]}
          />
          <Pressable
            testID={`route-row-${route.id || 'local'}-submit`}
            onPress={() => onConnect(route.id, pin)}
            disabled={pin.length === 0}
            style={({ pressed }) => [
              styles.submit,
              { backgroundColor: pin.length === 0 ? t.border : t.accent },
              pressed && { opacity: 0.7 },
            ]}
          >
            <Text style={{ color: t.background, fontSize: 13, fontWeight: '700' }}>Connect</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
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
  pairRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  pinInput: {
    flex: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    minHeight: 40,
  },
  submit: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
  },
});
