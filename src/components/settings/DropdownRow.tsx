import Ionicons from '@react-native-vector-icons/ionicons/static';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../../hooks/useTheme';
import { settingsStyles } from '../../styles/settingsStyles';

export interface DropdownOption<T> {
  value: T;
  label: string;
}

/**
 * Collapsible "select one of N" row used throughout the settings screens.
 *
 * Header shows `label` on the left and the current selection's label on
 * the right with a chevron; tapping toggles the option list below.
 * Selecting an option closes the list. Open/closed state is owned
 * locally — there's no upstream reason to lift this into a store.
 *
 * Designed to live inside a `settingsStyles.card`. Renders its own hairline
 * separators so multiple `DropdownRow`s in one card stack cleanly.
 */
export function DropdownRow<T extends string | number>({
  label,
  value,
  options,
  onChange,
  isLast = false,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<DropdownOption<T>>;
  onChange: (value: T) => void;
  /** Hide the header's bottom hairline (use when this is the last row of its card). */
  isLast?: boolean;
}) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);

  return (
    <>
      <Pressable
        onPress={() => setOpen((prev) => !prev)}
        style={({ pressed }) => [
          styles.header,
          !isLast && !open && {
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: colors.border,
          },
          pressed && settingsStyles.pressed,
        ]}
      >
        <Text style={[styles.label, { color: colors.textPrimary }]}>{label}</Text>
        <View style={styles.right}>
          <Text style={[styles.label, { color: colors.textSecondary }]} numberOfLines={1}>
            {current?.label ?? ''}
          </Text>
          <Ionicons
            name={open ? 'chevron-up' : 'chevron-down'}
            size={20}
            color={colors.textSecondary}
          />
        </View>
      </Pressable>
      {open && (
        <View style={[styles.optionList, { borderTopColor: colors.border }]}>
          {options.map((opt, index) => {
            const isActive = value === opt.value;
            const isLastOption = index === options.length - 1;
            return (
              <Pressable
                key={String(opt.value)}
                onPress={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                style={({ pressed }) => [
                  styles.option,
                  !isLastOption && {
                    borderBottomWidth: StyleSheet.hairlineWidth,
                    borderBottomColor: colors.border,
                  },
                  pressed && settingsStyles.pressed,
                ]}
              >
                <Text style={[styles.label, { color: colors.textPrimary }]}>{opt.label}</Text>
                {isActive && (
                  <Ionicons name="checkmark" size={20} color={colors.primary} />
                )}
              </Pressable>
            );
          })}
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  right: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  optionList: {
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  label: {
    fontSize: 16,
  },
});
