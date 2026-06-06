/**
 * Stub for any `@react-native-vector-icons/<set>/static` import in jest.
 *
 * The new vector-icons packages each export a default component whose
 * `name` prop is a narrowed string union. In tests we don't care about
 * the actual font rendering — we just want a placeholder that surfaces
 * the icon name and accessibility label for testing-library queries.
 *
 * Wired in via `jest.config.js`'s `moduleNameMapper`. Per-test
 * `jest.mock('@expo/vector-icons', ...)` calls were removed during the
 * SDK 56 vector-icons migration (the `@expo/vector-icons` package is
 * no longer installed).
 */

import { Text } from 'react-native';

interface IconStubProps {
  name?: string | number | symbol;
  accessibilityLabel?: string;
  color?: string;
  size?: number;
  style?: object | object[];
  testID?: string;
}

// Tests query the rendered element via `getByTestId('icon-<name>')` and
// then inspect `props.style.color` / `props.style.fontSize` — mirroring
// the old `@expo/vector-icons` mock shape. Forward color + size into
// a flat style object so those assertions resolve directly.
const IconStub = (props: IconStubProps) => {
  const baseStyle: Record<string, unknown> = {};
  if (props.color !== undefined) baseStyle.color = props.color;
  if (props.size !== undefined) baseStyle.fontSize = props.size;
  const extra = props.style;
  const flatExtra: Record<string, unknown> = Array.isArray(extra)
    ? Object.assign({}, ...extra)
    : (extra as Record<string, unknown> | undefined) ?? {};
  const style = { ...baseStyle, ...flatExtra };
  return (
    <Text
      accessibilityLabel={props.accessibilityLabel}
      testID={props.testID ?? (props.name != null ? `icon-${String(props.name)}` : undefined)}
      style={style}
    >
      {props.name != null ? String(props.name) : ''}
    </Text>
  );
};

export default IconStub;
