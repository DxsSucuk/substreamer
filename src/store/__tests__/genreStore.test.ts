jest.mock('../persistence/kvStorage', () => require('../persistence/__mocks__/kvStorage'));

const mockGetGenres = jest.fn();

jest.mock('../../services/subsonicService', () => ({
  getGenres: () => mockGetGenres(),
}));

import { genreStore } from '../genreStore';

beforeEach(() => {
  mockGetGenres.mockReset();
  genreStore.setState({ genres: [], sqlAuthoritative: false });
});

describe('genreStore', () => {
  it('starts with empty genres', () => {
    expect(genreStore.getState().genres).toEqual([]);
  });

  it('fetchGenres populates genres on success', async () => {
    const genres = [
      { value: 'Rock', songCount: 100, albumCount: 10 },
      { value: 'Jazz', songCount: 50, albumCount: 5 },
    ];
    mockGetGenres.mockResolvedValue(genres);

    await genreStore.getState().fetchGenres();

    expect(genreStore.getState().genres).toEqual(genres);
  });

  it('fetchGenres does not update state when API returns null', async () => {
    genreStore.setState({ genres: [{ value: 'Rock', songCount: 10, albumCount: 1 }] });
    mockGetGenres.mockResolvedValue(null);

    await genreStore.getState().fetchGenres();

    expect(genreStore.getState().genres).toEqual([
      { value: 'Rock', songCount: 10, albumCount: 1 },
    ]);
  });

  it('fetchGenres replaces existing genres on refresh', async () => {
    genreStore.setState({ genres: [{ value: 'Rock', songCount: 10, albumCount: 1 }] });
    const newGenres = [{ value: 'Pop', songCount: 200, albumCount: 20 }];
    mockGetGenres.mockResolvedValue(newGenres);

    await genreStore.getState().fetchGenres();

    expect(genreStore.getState().genres).toEqual(newGenres);
  });

  describe('partialize', () => {
    const partialize = (): Record<string, unknown> =>
      (genreStore as any).persist.getOptions().partialize(genreStore.getState());

    it('persists the genres blob while the rows are unproven, never the action', () => {
      genreStore.setState({
        genres: [{ value: 'Rock', songCount: 10, albumCount: 1 }],
        sqlAuthoritative: false,
      });
      const partialized = partialize();
      expect(partialized).toHaveProperty('genres');
      expect(partialized).not.toHaveProperty('fetchGenres');
    });

    it('drops the genres blob once the rows are authoritative', () => {
      genreStore.setState({
        genres: [{ value: 'Rock', songCount: 10, albumCount: 1 }],
        sqlAuthoritative: true,
      });
      expect(partialize()).toEqual({});
    });
  });
});
