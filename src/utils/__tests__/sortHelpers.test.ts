import {
  DEFAULT_IGNORED_ARTICLES,
  getSortKey,
  letterOfSortKey,
  stripArticle,
  stripLeadingPunctuation,
} from '../sortHelpers';

/** The composition the list views make: SQL stores `getSortKey(...)`, the scroller
 *  letters that stored key. Asserted here as one step so these cases keep covering the
 *  whole chain, which is what they were written against. */
const letterOf = (name: string, sortName?: string | null, articles?: readonly string[]): string =>
  letterOfSortKey(getSortKey(name, sortName, articles));

describe('stripLeadingPunctuation', () => {
  it('drops every leading non-alphanumeric character', () => {
    expect(stripLeadingPunctuation('"Heroes"')).toBe('Heroes"');
    expect(stripLeadingPunctuation('(How to Live)')).toBe('How to Live)');
    expect(stripLeadingPunctuation("'74 Jailbreak")).toBe('74 Jailbreak');
    expect(stripLeadingPunctuation('  Spaced')).toBe('Spaced');
  });

  it('leaves a name that already starts with a letter or digit alone', () => {
    expect(stripLeadingPunctuation('Pearl Jam')).toBe('Pearl Jam');
    expect(stripLeadingPunctuation('12 Stones')).toBe('12 Stones');
  });

  it('never collapses to empty', () => {
    expect(stripLeadingPunctuation('???')).toBe('???');
    expect(stripLeadingPunctuation('')).toBe('');
  });

  it('keeps non-Latin letters, which are letters', () => {
    expect(stripLeadingPunctuation('Ω Project')).toBe('Ω Project');
    expect(stripLeadingPunctuation('«Мир»')).toBe('Мир»');
  });
});

describe('stripArticle (default list)', () => {
  it('strips each default article when followed by whitespace', () => {
    for (const article of DEFAULT_IGNORED_ARTICLES) {
      const cap = article.charAt(0).toUpperCase() + article.slice(1);
      expect(stripArticle(`${cap} Band`)).toBe('Band');
    }
  });

  it('does NOT strip an article when not followed by whitespace', () => {
    expect(stripArticle('Theatre')).toBe('Theatre');
    expect(stripArticle('Lacuna')).toBe('Lacuna');
  });

  it('strips only one article (no iterative strip)', () => {
    // "The The" → strip first "The ", remainder is "The". Sort under T.
    expect(stripArticle('The The')).toBe('The');
  });

  it('returns the original when stripping would leave an empty string', () => {
    expect(stripArticle('The')).toBe('The');
    expect(stripArticle('Le ')).toBe('Le ');
  });

  it('does NOT strip articles that are excluded from the default list', () => {
    // English a/an stay (per user direction)
    expect(stripArticle('A Tribe Called Quest')).toBe('A Tribe Called Quest');
    expect(stripArticle('An American In Paris')).toBe('An American In Paris');
    // English preposition "as"
    expect(stripArticle('As I Lay Dying')).toBe('As I Lay Dying');
    // Dutch/French "de" — "De La Soul" keeps the De (no false positive)
    expect(stripArticle('De La Soul')).toBe('De La Soul');
    // German articles
    expect(stripArticle('Die Toten Hosen')).toBe('Die Toten Hosen');
    expect(stripArticle('Der Plan')).toBe('Der Plan');
    // Italian
    expect(stripArticle('Il Divo')).toBe('Il Divo');
    expect(stripArticle('I Mother Earth')).toBe('I Mother Earth');
    // Portuguese conjunction (not an article)
    expect(stripArticle('E Street Band')).toBe('E Street Band');
  });

  it('handles `L\'` apostrophe form with a straight quote', () => {
    expect(stripArticle("L'amour")).toBe('amour');
    expect(stripArticle("L'  Île")).toBe('Île');
  });

  it('handles `L\'` apostrophe form with a smart quote (U+2019)', () => {
    expect(stripArticle('L’amour')).toBe('amour');
  });

  it('is case-insensitive', () => {
    expect(stripArticle('THE BEATLES')).toBe('BEATLES');
    expect(stripArticle('the beatles')).toBe('beatles');
    expect(stripArticle('LOS LOBOS')).toBe('LOBOS');
  });
});

describe('stripArticle with server-supplied article list', () => {
  it('uses the server-supplied list when provided', () => {
    // Server with German articles configured
    const articles = ['the', 'die', 'der', 'das'];
    expect(stripArticle('Die Toten Hosen', articles)).toBe('Toten Hosen');
    expect(stripArticle('The Beatles', articles)).toBe('Beatles');
  });

  it('caches the compiled regex per article-list identity', () => {
    const articles = Object.freeze(['the', 'die']);
    // Just call twice; mainly asserting no throw / consistent output.
    expect(stripArticle('Die Band', articles)).toBe('Band');
    expect(stripArticle('Die Band', articles)).toBe('Band');
  });

  it('handles an empty server-supplied list as a no-op (no strip)', () => {
    expect(stripArticle('The Beatles', [])).toBe('The Beatles');
  });
});

describe('getSortKey', () => {
  it('falls back to client-strip when sortName is undefined', () => {
    expect(getSortKey('The Beatles')).toBe('beatles');
  });

  it('falls back to client-strip when sortName equals name', () => {
    expect(getSortKey('The Beatles', 'The Beatles')).toBe('beatles');
  });

  it('uses sortName when it differs from name and is not comma-suffix form', () => {
    expect(getSortKey('The Beatles', 'Beatles')).toBe('beatles');
    expect(getSortKey('U2', 'You Two')).toBe('you two');
  });

  it('ignores comma-suffix sortName ("Beatles, The") and falls back to client-strip', () => {
    expect(getSortKey('The Beatles', 'Beatles, The')).toBe('beatles');
  });

  it('lowercases the result', () => {
    expect(getSortKey('THE BEATLES')).toBe('beatles');
  });

  it('folds accents — "Élise" sorts under e', () => {
    expect(getSortKey('Élise')).toBe('elise');
    expect(getSortKey('Über alles')).toBe('uber alles');
    expect(getSortKey('Ñoño')).toBe('nono');
  });

  it('preserves names without leading articles', () => {
    expect(getSortKey('Pearl Jam')).toBe('pearl jam');
    expect(getSortKey('U2')).toBe('u2');
  });

  it('drops leading punctuation so it cannot decide where a row files', () => {
    expect(getSortKey('"Heroes"')).toBe('heroes"');
    expect(getSortKey('(How to Live) As Ghosts')).toBe('how to live) as ghosts');
    expect(getSortKey('…And Justice for All')).toBe('and justice for all');
  });

  it('leaves a DIGIT leading — a number is not a letter and belongs in #', () => {
    expect(getSortKey("'74 Jailbreak")).toBe('74 jailbreak');
    expect(getSortKey('12 Stones')).toBe('12 stones');
  });

  it('strips punctuation BEFORE the article, so a quoted article still strips', () => {
    expect(getSortKey('"The Wall"')).toBe('wall"');
  });

  it('drops leading punctuation from a server sortName too', () => {
    expect(getSortKey('Heroes', '"Heroes"')).toBe('heroes"');
  });

  it('never collapses a punctuation-only name to empty', () => {
    expect(getSortKey('???')).toBe('???');
    expect(getSortKey('!!!')).toBe('!!!');
  });
});

describe('letterOfSortKey, over a key from getSortKey', () => {
  it('returns the first A–Z letter of the sort key', () => {
    expect(letterOf('The Beatles')).toBe('B');
    expect(letterOf('Pearl Jam')).toBe('P');
  });

  it('returns "#" for a leading DIGIT', () => {
    expect(letterOf('12 Stones')).toBe('#');
    expect(letterOf("'74 Jailbreak")).toBe('#');
  });

  /** The scroller reads `charAt(0)` of the key, so the punctuation strip reaches it for
   *  free — which is exactly what keeps the letter and the row's position coherent. */
  it('files a punctuation-leading name under its first LETTER', () => {
    expect(letterOf('!Action')).toBe('A');
    expect(letterOf('"Heroes"')).toBe('H');
    expect(letterOf('(How to Live) As Ghosts')).toBe('H');
  });

  it('still returns "#" when there is no letter or digit at all', () => {
    expect(letterOf('???')).toBe('#');
  });

  it('returns the accent-folded letter — "Élise" → E', () => {
    expect(letterOf('Élise')).toBe('E');
    expect(letterOf('Über alles')).toBe('U');
    expect(letterOf('Ñoño')).toBe('N');
  });

  it('returns the band-letter when an indefinite article is in front (a/an stay)', () => {
    expect(letterOf('A Tribe Called Quest')).toBe('A');
    expect(letterOf('An American In Paris')).toBe('A');
  });

  it('honours server-supplied article list', () => {
    const articles = ['the', 'die'];
    expect(letterOf('Die Toten Hosen', undefined, articles)).toBe('T');
  });

  it('returns "T" for "The The" (single-iteration strip)', () => {
    expect(letterOf('The The')).toBe('T');
  });

  it('uses sortName when present and meaningful', () => {
    expect(letterOf('The Beatles', 'Beatles')).toBe('B');
    expect(letterOf('U2', 'You Two')).toBe('Y');
  });

  it('falls back to client-strip on comma-suffix sortName', () => {
    expect(letterOf('The Beatles', 'Beatles, The')).toBe('B');
  });

  /** The helper takes an ALREADY-derived key and never re-derives one. These are the
   *  raw-key cases the views hand it: a stored `sort_*` column, or `''` for a row the
   *  key rebuild has not reached. */
  it('reads the key it is given verbatim, deriving nothing', () => {
    expect(letterOfSortKey('the beatles')).toBe('T');
    expect(letterOfSortKey('"heroes"')).toBe('#');
    expect(letterOfSortKey('')).toBe('#');
    expect(letterOfSortKey('élise')).toBe('#');
  });
});
