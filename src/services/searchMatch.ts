/**
 * Client-side fuzzy-search matching primitives — normalization, phonetic keys,
 * string-similarity metrics, and a tiered scorer.
 *
 * Pure + deterministic. The persistence layer stores `normalize()` /
 * `metaphoneKey()` output as indexed columns for SQL candidate generation; the
 * resolver re-ranks the (bounded) candidate rows with `scoreCandidate()`.
 * Engine-agnostic — no SQLite, no store access.
 *
 * Design notes:
 * - Double Metaphone is Latin-only; non-Latin tokens encode to '' and are
 *   EXCLUDED from the key so CJK/Cyrillic titles don't all collide on `dmeta=''`.
 * - Phonetic is recall-only: it never promotes above exact/prefix/all-token
 *   matches and is gated behind a min length + a secondary string-similarity floor.
 */
import { doubleMetaphone } from 'double-metaphone';
import { distance as levenshtein } from 'fastest-levenshtein';

import { foldAccents, stripArticle } from '../utils/sortHelpers';

/** Score at/above which a local match is trusted (no server fallback needed). */
export const CONFIDENT = 0.8;
/** Candidates scoring below this are discarded as non-matches. */
export const REJECT = 0.55;

// Cheap, high-value canonicalizations for music metadata.
const CANON: Array<[RegExp, string]> = [
  [/&/g, ' and '],
  [/\bpt\b\.?/g, 'part'],
  [/\bvol\b\.?/g, 'volume'],
];

// Qualifier "noise" in titles that hurts matching (parenthetical/bracketed
// remaster/live/feat/etc.). Stripped for the normalized comparison key.
const NOISE =
  /\((?:feat|ft|featuring|with|remaster|radio edit|live|explicit|deluxe|mono|stereo|bonus|remix|version)[^)]*\)|\[[^\]]*\]/gi;

/**
 * Normalize a term for matching: accent-fold, lowercase, drop qualifier noise,
 * canonicalize (`&`→`and`, `pt`→`part`, …), strip punctuation, collapse spaces.
 */
export function normalize(input: string | null | undefined): string {
  if (!input) return '';
  let s = foldAccents(String(input)).toLowerCase();
  s = s.replace(NOISE, ' ');
  for (const [re, rep] of CANON) s = s.replace(re, rep);
  s = s.replace(/['‘’]/g, ''); // apostrophes: don't → dont (no split)
  s = s.replace(/[^\p{L}\p{N}\s]+/gu, ' '); // other punctuation → space
  return s.replace(/\s+/g, ' ').trim();
}

/** Like {@link normalize} but also strips a leading article ("the beatles" →
 *  "beatles") — for the artist field only. */
export function normalizeArtist(input: string | null | undefined): string {
  return normalize(stripArticle(String(input ?? '')));
}

/** Normalized whitespace-separated tokens. */
export function tokenize(input: string | null | undefined): string[] {
  const n = normalize(input);
  return n ? n.split(' ') : [];
}

/**
 * Per-token Double-Metaphone primary codes, space-joined (the stored `dmeta_*`
 * column). Empty codes (non-Latin tokens) are excluded so they never collide.
 */
export function metaphoneKey(input: string | null | undefined): string {
  const out: string[] = [];
  for (const tok of tokenize(input)) {
    const [primary] = doubleMetaphone(tok);
    if (primary) out.push(primary);
  }
  return out.join(' ');
}

/** Jaro-Winkler similarity (0..1) — prefix-weighted, good for short names. */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  const la = a.length;
  const lb = b.length;
  if (la === 0 || lb === 0) return 0;
  const window = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const aM = new Array<boolean>(la).fill(false);
  const bM = new Array<boolean>(lb).fill(false);
  let matches = 0;
  for (let i = 0; i < la; i++) {
    const start = Math.max(0, i - window);
    const end = Math.min(i + window + 1, lb);
    for (let j = start; j < end; j++) {
      if (bM[j] || a[i] !== b[j]) continue;
      aM[i] = true;
      bM[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < la; i++) {
    if (!aM[i]) continue;
    while (!bM[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  transpositions /= 2;
  const jaro =
    (matches / la + matches / lb + (matches - transpositions) / matches) / 3;
  let prefix = 0;
  const maxPrefix = Math.min(4, la, lb);
  for (let i = 0; i < maxPrefix; i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** Normalized edit-distance similarity (0..1). */
export function editRatio(a: string, b: string): number {
  const m = Math.max(a.length, b.length);
  return m === 0 ? 1 : 1 - levenshtein(a, b) / m;
}

/** Best of Jaro-Winkler (prefix) and edit ratio (typos/transpositions). */
export function similarity(a: string, b: string): number {
  return Math.max(jaroWinkler(a, b), editRatio(a, b));
}

export type MatchTier =
  | 'exact'
  | 'prefix'
  | 'all-tokens'
  | 'fuzzy'
  | 'phonetic'
  | 'none';

export interface FieldScore {
  score: number;
  tier: MatchTier;
}

/**
 * Best similarity of ONE query token to any of the candidate's tokens, with a
 * phonetic-equivalence boost (corn≈korn, rose≈roze) so a misspelled/plural word
 * still aligns to its counterpart. Exact token match short-circuits at 1.
 */
function bestTokenSim(qt: string, cTokens: readonly string[]): number {
  let best = 0;
  let qKey: string | null = null;
  for (const ct of cTokens) {
    if (ct === qt) return 1;
    let s = similarity(qt, ct);
    // Phonetic boost only for an already visually-plausible pair (≥0.7), and
    // additive — else same-code but distant words (corn/green, both 'KRN') would
    // tie with the real target (corn/korn).
    if (s >= 0.7 && s < 0.95 && qt.length >= 3 && ct.length >= 3) {
      if (qKey === null) qKey = doubleMetaphone(qt)[0] ?? '';
      if (qKey && qKey === (doubleMetaphone(ct)[0] ?? '')) s = Math.min(0.95, s + 0.12);
    }
    if (s > best) best = s;
    if (best === 1) break;
  }
  return best;
}

/**
 * Tiered similarity of a query term to a candidate field (both raw; normalized
 * inside). exact > prefix > all-tokens(any order) > fuzzy > phonetic. Exact and
 * prefix always outrank any fuzzy/phonetic tier.
 */
export function scoreField(query: string, candidate: string): FieldScore {
  const q = normalize(query);
  const c = normalize(candidate);
  if (!q || !c) return { score: 0, tier: 'none' };
  if (q === c) return { score: 1, tier: 'exact' };

  const lenRatio = Math.min(q.length, c.length) / Math.max(q.length, c.length);
  if (c.startsWith(q)) return { score: 0.88 + 0.04 * lenRatio, tier: 'prefix' };

  const cTokens = c.split(' ');
  const cTokenSet = new Set(cTokens);
  const qTokens = q.split(' ');
  if (qTokens.every((t) => cTokenSet.has(t))) {
    return { score: 0.86, tier: 'all-tokens' };
  }

  // Per-token alignment: each query token vs its best candidate token
  // (fuzzy + phonetic), blending the mean with the weakest token so a word that
  // aligns to nothing drags the score down (ranks "stone rose" → Stone Roses).
  const perTok = qTokens.map((qt) => bestTokenSim(qt, cTokens));
  const meanTok = perTok.reduce((sum, s) => sum + s, 0) / perTok.length;
  const minTok = Math.min(...perTok);
  const alignment = 0.5 * meanTok + 0.5 * minTok;

  // Whole-string similarity too (single-token typos / run-together forms).
  const sim = similarity(q, c);
  const best = Math.max(alignment, sim);

  // Fuzzy band, kept below the all-tokens (0.86)/prefix/exact floors so a fuzzy
  // hit never outranks a literal one. Phonetic recall lives in the per-token
  // alignment (visually gated), so there's no separate whole-key phonetic tier.
  if (best >= 0.9) return { score: 0.6 + 0.25 * best, tier: 'fuzzy' }; // 0.825..0.85
  if (best >= 0.62) return { score: 0.55 + 0.5 * (best - 0.62), tier: 'fuzzy' }; // 0.55..~0.69
  return { score: best * 0.5, tier: 'none' };
}

export interface Candidate {
  title: string;
  artist?: string | null;
}

/**
 * Combined score for a candidate against a structured query. Title carries the
 * weight; when an artist term is present it must reasonably agree (else the
 * candidate is heavily penalized — kills right-title/wrong-artist hits).
 */
export function scoreCandidate(
  q: { song?: string; artist?: string },
  cand: Candidate,
): number {
  const titleScore = scoreField(q.song ?? '', cand.title).score;
  const artistTerm = q.artist?.trim();
  if (!artistTerm) return titleScore;
  const a = scoreField(artistTerm, cand.artist ?? '');
  if (a.score < 0.7) return titleScore * 0.5; // wrong / missing artist
  return 0.65 * titleScore + 0.35 * a.score;
}
