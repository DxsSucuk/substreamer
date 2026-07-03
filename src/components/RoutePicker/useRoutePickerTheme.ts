import { useMemo } from 'react';

import { useTheme } from '../../hooks/useTheme';
import { type RoutePickerTheme } from './types';

/** Colour used for error indicators (the app theme has no dedicated error token). */
const ERROR_RED = '#ff453a';

/**
 * Build a RoutePickerTheme from the app's theme colours. Any tokens passed in
 * `override` win, so a call site can tweak individual colours.
 */
export function useRoutePickerTheme(override?: Partial<RoutePickerTheme>): RoutePickerTheme {
  const { colors } = useTheme();
  return useMemo(
    () => ({
      background: colors.card,
      surface: colors.inputBg,
      text: colors.textPrimary,
      textSubtle: colors.textSecondary,
      border: colors.border,
      accent: colors.primary,
      activeIndicator: colors.primary,
      connectingIndicator: colors.primary,
      errorIndicator: ERROR_RED,
      ...override,
    }),
    [colors, override],
  );
}
