jest.mock('../../store/persistence/kvStorage', () =>
  require('../../store/persistence/__mocks__/kvStorage'),
);

jest.mock('../../hooks/useTheme', () => ({
  useTheme: () => ({
    colors: { background: '#000', primary: '#f60', textPrimary: '#fff', textSecondary: '#888' },
  }),
}));

jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  useSharedValue: () => ({ value: 0 }),
  useAnimatedStyle: () => ({}),
}));

jest.mock('@shopify/flash-list', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    FlashList: React.forwardRef(function MockFlashList(
      { data, ListEmptyComponent }: { data: unknown[]; ListEmptyComponent?: React.ReactNode },
      _ref: unknown,
    ) {
      // FlashList renders `ListEmptyComponent` in place of the rows when `data` is empty.
      return <View testID="flash-list">{data?.length === 0 ? ListEmptyComponent : null}</View>;
    }),
  };
});

import React from 'react';
import { ActivityIndicator } from 'react-native';
import { render } from '@testing-library/react-native';

import { AlbumListView } from '../AlbumListView';
import { ArtistListView } from '../ArtistListView';
import { SongListView } from '../SongListView';

/**
 * The other half of the "favourites filter must not flash an empty state" contract:
 * the screens promise `loading: true` on the first frame (see the three
 * `src/screens/__tests__/*-list*.test.tsx` suites), and these views promise that a
 * loading, row-less list shows a spinner rather than the placeholder.
 */
const views = [
  {
    name: 'AlbumListView',
    render: (loading: boolean) => <AlbumListView albums={[]} loading={loading} />,
    empty: 'No albums found',
  },
  {
    name: 'ArtistListView',
    render: (loading: boolean) => <ArtistListView artists={[]} loading={loading} />,
    empty: 'No artists found',
  },
  {
    name: 'SongListView',
    render: (loading: boolean) => <SongListView songs={[]} loading={loading} />,
    empty: 'No songs found',
  },
];

describe.each(views)('$name — loading vs empty precedence', ({ render: renderView, empty }) => {
  it('shows a spinner and NO placeholder while loading with no rows', () => {
    const r = render(renderView(true));
    expect(r.UNSAFE_queryAllByType(ActivityIndicator)).toHaveLength(1);
    expect(r.queryByText(empty)).toBeNull();
  });

  it('shows the default placeholder once loading finishes with no rows', () => {
    const r = render(renderView(false));
    expect(r.UNSAFE_queryAllByType(ActivityIndicator)).toHaveLength(0);
    // The default copy — the song library no longer overrides it with a bespoke message.
    expect(r.getByText(empty)).toBeTruthy();
  });
});
