import { useWindowDimensions } from 'react-native';

type LayoutMode = 'compact' | 'wide';

/** Returns the layout mode for a given window width and height. Wide mode requires landscape orientation (width > height) and sufficient width. */
export function getLayoutMode(width: number, height: number): LayoutMode {
  return width >= 900 && width > height ? 'wide' : 'compact';
}

/** Hook that returns the current layout mode based on window dimensions. */
export function useLayoutMode(): LayoutMode {
  const { width, height } = useWindowDimensions();
  return getLayoutMode(width, height);
}
