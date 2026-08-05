import { render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { EmptyState } from '../EmptyState';

describe('EmptyState', () => {
  it('centres the title as well as the subtitle', () => {
    // A one-line title looks centred either way, because the Text block itself is
    // centred by the container. The bug only shows once the title WRAPS: without
    // `textAlign` the second line goes hard left against a centred icon and subtitle.
    const { getByText } = render(
      <EmptyState
        icon="musical-notes-outline"
        title="A title long enough that it has to wrap onto a second line"
        subtitle="Try adjusting your filters"
      />,
    );

    const title = StyleSheet.flatten(getByText(/A title long enough/).props.style);
    const subtitle = StyleSheet.flatten(getByText('Try adjusting your filters').props.style);
    expect(title.textAlign).toBe('center');
    expect(subtitle.textAlign).toBe('center');
  });

  it('renders without a subtitle', () => {
    const { getByText, queryByText } = render(
      <EmptyState icon="musical-notes-outline" title="Nothing here" />,
    );
    expect(getByText('Nothing here')).toBeTruthy();
    expect(queryByText('Try adjusting your filters')).toBeNull();
  });
});
