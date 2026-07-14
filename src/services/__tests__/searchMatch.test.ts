import {
  normalize,
  normalizeArtist,
  tokenize,
  metaphoneKey,
  jaroWinkler,
  editRatio,
  scoreField,
  scoreCandidate,
  CONFIDENT,
} from '../searchMatch';

describe('normalize', () => {
  it('folds accents + lowercases', () => {
    expect(normalize('Café Tacvba')).toBe('cafe tacvba');
    expect(normalize('Motörhead')).toBe('motorhead');
  });
  it('canonicalizes & → and', () => {
    expect(normalize('Simon & Garfunkel')).toBe('simon and garfunkel');
  });
  it('strips qualifier noise + brackets', () => {
    expect(normalize('Narcotic (Radio Edit)')).toBe('narcotic');
    expect(normalize('Song [2019 Remaster]')).toBe('song');
    expect(normalize('Title (feat. Someone)')).toBe('title');
  });
  it('strips punctuation + collapses whitespace', () => {
    expect(normalize("  Don't   Stop!! ")).toBe('dont stop');
  });
  it('handles null/empty', () => {
    expect(normalize(null)).toBe('');
    expect(normalize('')).toBe('');
  });
});

describe('normalizeArtist', () => {
  it('strips a leading article', () => {
    expect(normalizeArtist('The Beatles')).toBe('beatles');
    expect(normalizeArtist('The xx')).toBe('xx');
  });
});

describe('tokenize', () => {
  it('splits normalized tokens', () => {
    expect(tokenize('Freak on a Leash')).toEqual(['freak', 'on', 'a', 'leash']);
  });
});

describe('metaphoneKey', () => {
  it('encodes Korn and Corn to the same key (flagship fuzzy case)', () => {
    expect(metaphoneKey('Korn')).toBe(metaphoneKey('Corn'));
    expect(metaphoneKey('Korn')).toBe('KRN');
  });
  it('is per-token (multi-word survives)', () => {
    // "smashing pumpkins" vs a typo — per-token so it doesn't collapse.
    expect(metaphoneKey('smashing pumpkins').split(' ').length).toBe(2);
  });
  it('excludes empty codes for non-Latin (no CJK collision)', () => {
    // Non-Latin tokens → no code → empty key, NOT a shared '' that collides.
    expect(metaphoneKey('日本語')).toBe('');
  });
});

describe('jaroWinkler / editRatio', () => {
  it('identical = 1, korn/corn high, disjoint low', () => {
    expect(jaroWinkler('korn', 'korn')).toBe(1);
    expect(jaroWinkler('korn', 'corn')).toBeGreaterThan(0.8);
    expect(jaroWinkler('abc', 'xyz')).toBeLessThan(0.5);
  });
  it('editRatio for a single substitution', () => {
    expect(editRatio('korn', 'corn')).toBeCloseTo(0.75, 5);
  });
});

describe('scoreField tiers', () => {
  it('exact match scores 1.0', () => {
    expect(scoreField('Freak on a Leash', 'Freak on a Leash')).toEqual({
      score: 1,
      tier: 'exact',
    });
  });
  it('prefix beats fuzzy', () => {
    const r = scoreField('freak', 'Freak on a Leash');
    expect(r.tier).toBe('prefix');
    expect(r.score).toBeGreaterThan(0.85);
  });
  it('all tokens present, any order', () => {
    const r = scoreField('leash freak', 'Freak on a Leash');
    expect(r.tier).toBe('all-tokens');
  });
  it('phonetic: corn matches korn (gated), below exact/prefix', () => {
    const r = scoreField('corn', 'Korn');
    expect(['phonetic', 'fuzzy']).toContain(r.tier);
    expect(r.score).toBeLessThan(0.9); // never outranks a prefix/exact
    expect(r.score).toBeGreaterThan(0);
  });
  it('no match scores low', () => {
    expect(scoreField('zzzz', 'Freak on a Leash').score).toBeLessThan(0.5);
  });
});

describe('scoreCandidate', () => {
  const freakKorn = { title: 'Freak on a Leash', artist: 'Korn' };
  const freakOther = { title: 'Freak on a Leash', artist: 'Other Band' };

  it('song-only: matches on title', () => {
    expect(scoreCandidate({ song: 'Freak on a Leash' }, freakKorn)).toBeGreaterThanOrEqual(
      CONFIDENT,
    );
  });
  it('song + artist: prefers the matching artist', () => {
    const korn = scoreCandidate({ song: 'Freak on a Leash', artist: 'Korn' }, freakKorn);
    const other = scoreCandidate({ song: 'Freak on a Leash', artist: 'Korn' }, freakOther);
    expect(korn).toBeGreaterThan(other);
  });
  it('typo artist (corn) still prefers Korn via phonetic', () => {
    const korn = scoreCandidate({ song: 'Freak on a Leash', artist: 'corn' }, freakKorn);
    const other = scoreCandidate({ song: 'Freak on a Leash', artist: 'corn' }, freakOther);
    expect(korn).toBeGreaterThan(other);
  });
  it('wrong artist is penalized below the title-only score', () => {
    const wrong = scoreCandidate({ song: 'Freak on a Leash', artist: 'Metallica' }, freakKorn);
    expect(wrong).toBeLessThan(scoreCandidate({ song: 'Freak on a Leash' }, freakKorn));
  });
});
