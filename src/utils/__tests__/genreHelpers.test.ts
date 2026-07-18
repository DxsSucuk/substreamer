import { getGenreNames, getPrimaryGenre, splitGenreValue } from '../genreHelpers';

describe('getGenreNames', () => {
  it('extracts names from {name} objects (real runtime shape)', () => {
    const item = { genres: [{ name: 'Rock' }, { name: 'Jazz' }] };
    expect(getGenreNames(item)).toEqual(['Rock', 'Jazz']);
  });

  it('handles plain strings defensively', () => {
    const item = { genres: ['Electronic', 'Ambient'] };
    expect(getGenreNames(item)).toEqual(['Electronic', 'Ambient']);
  });

  it('handles mixed elements', () => {
    const item = { genres: [{ name: 'Rock' }, 'Jazz', 42, null] };
    expect(getGenreNames(item)).toEqual(['Rock', 'Jazz']);
  });

  it('falls back to singular genre when genres is absent', () => {
    const item = { genre: 'Classical' };
    expect(getGenreNames(item)).toEqual(['Classical']);
  });

  it('falls back to singular genre when genres is empty', () => {
    const item = { genre: 'Blues', genres: [] };
    expect(getGenreNames(item)).toEqual(['Blues']);
  });

  it('returns empty array when no genre data', () => {
    expect(getGenreNames({})).toEqual([]);
    expect(getGenreNames(null)).toEqual([]);
    expect(getGenreNames(undefined)).toEqual([]);
  });

  it('deduplicates genre names', () => {
    const item = { genres: [{ name: 'Rock' }, { name: 'Rock' }, { name: 'Jazz' }] };
    expect(getGenreNames(item)).toEqual(['Rock', 'Jazz']);
  });

  it('skips malformed elements', () => {
    const item = { genres: [{ name: '' }, { name: 123 }, {}, { name: 'Valid' }] };
    expect(getGenreNames(item)).toEqual(['Valid']);
  });

  it('does not split comma-joined genre strings', () => {
    const item = { genre: 'Folk, World, & Country' };
    expect(getGenreNames(item)).toEqual(['Folk, World, & Country']);
  });

  it('prefers genres array over singular genre', () => {
    const item = { genre: 'Rock', genres: [{ name: 'Electronic' }] };
    expect(getGenreNames(item)).toEqual(['Electronic']);
  });

  it('trims whitespace from genre names', () => {
    const item = { genres: [{ name: '  Rock  ' }, ' Jazz '] };
    expect(getGenreNames(item)).toEqual(['Rock', 'Jazz']);
  });

  it('skips elements with empty-after-trim names', () => {
    const item = { genres: [{ name: '   ' }, { name: 'Valid' }] };
    expect(getGenreNames(item)).toEqual(['Valid']);
  });
});

describe('getPrimaryGenre', () => {
  it('returns first genre name from {name} objects', () => {
    expect(getPrimaryGenre({ genres: [{ name: 'Rock' }, { name: 'Jazz' }] })).toBe('Rock');
  });

  it('returns singular genre when genres absent', () => {
    expect(getPrimaryGenre({ genre: 'Classical' })).toBe('Classical');
  });

  it('returns null when no genre data', () => {
    expect(getPrimaryGenre({})).toBeNull();
    expect(getPrimaryGenre(null)).toBeNull();
    expect(getPrimaryGenre(undefined)).toBeNull();
  });

  it('handles plain string in genres array', () => {
    expect(getPrimaryGenre({ genres: ['Electronic'] })).toBe('Electronic');
  });
});

describe('splitGenreValue', () => {
  it('splits a compound tag and strips a leading conjunction', () => {
    expect(splitGenreValue('Folk, World, & Country')).toEqual(['Folk', 'World', 'Country']);
    expect(splitGenreValue('Rock; Pop / Jazz')).toEqual(['Rock', 'Pop', 'Jazz']);
  });

  it('leaves single-value names with & intact (no delimiter)', () => {
    expect(splitGenreValue('R&B')).toEqual(['R&B']);
    expect(splitGenreValue('Rock & Roll')).toEqual(['Rock & Roll']);
    expect(splitGenreValue('Drum & Bass')).toEqual(['Drum & Bass']);
    expect(splitGenreValue('Hip-Hop')).toEqual(['Hip-Hop']);
  });

  it('trims, drops empties, and dedupes', () => {
    expect(splitGenreValue('Rock,  , Rock ,Pop')).toEqual(['Rock', 'Pop']);
    expect(splitGenreValue('')).toEqual([]);
  });
});
