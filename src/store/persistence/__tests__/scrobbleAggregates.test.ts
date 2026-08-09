/**
 * SQL scrobble analytics (the OOM fix): aggregates come from GROUP BY over the
 * structured columns, scoped by an optional `sinceMs`. Also covers the one-time
 * backfill of derived columns for rows written before the columns existed.
 */
import type { Child } from 'subsonic-api';

import { getDb } from '../db';
import {
  computeScrobbleAnalytics,
  loadRecentScrobbles,
} from '../scrobbleAggregates';
import { backfillScrobbleColumnsAsync } from '../scrobbleTable';
import { deriveScrobbleColumns, scrobbleColumnValues, SCROBBLE_COLUMN_NAMES } from '../scrobbleColumns';
import {
  createLegacyScrobbleTables,
  createScrobbleTables,
} from '../../../test-utils/legacyScrobbleTables';

const db = () => getDb()!;

const song = (id: string, extra: Partial<Child> = {}): Child =>
  ({ id, title: id, isDir: false, ...extra }) as Child;

// Insert directly via the same column set the write path uses.
const insert = (id: string, s: Child, time: number): void => {
  const cols = scrobbleColumnValues(deriveScrobbleColumns(s, time));
  db().runSync(
    `INSERT INTO scrobble_events (id, time, ${SCROBBLE_COLUMN_NAMES.join(', ')}) ` +
      `VALUES (${new Array(2 + SCROBBLE_COLUMN_NAMES.length).fill('?').join(', ')});`,
    [id, time, ...cols],
  );
};

const HOUR = 3_600_000;
const DAY = 86_400_000;
// A fixed "now" far enough back that the fabricated times below are stable.
const NOW = 1_700_000_000_000;

beforeEach(() => {
  // Rebuild rather than DELETE: one case below swaps in the legacy table shape.
  createScrobbleTables(db());
});

it('computes all-time aggregates from GROUP BY', async () => {
  insert('e1', song('s1', { artist: 'A', artistId: 'ar-a', album: 'AlbA', albumId: 'al-a', duration: 100, genres: [{ name: 'Rock' }] as any }), NOW);
  insert('e2', song('s1', { artist: 'A', artistId: 'ar-a', album: 'AlbA', albumId: 'al-a', duration: 100, genres: [{ name: 'Rock' }] as any }), NOW + HOUR);
  insert('e3', song('s2', { artist: 'B', album: 'AlbB', duration: 200, genres: [{ name: 'Jazz' }] as any }), NOW + 2 * HOUR);

  const { stats, aggregates } = await computeScrobbleAnalytics(0);
  expect(stats.totalPlays).toBe(3);
  expect(stats.totalListeningSeconds).toBe(400); // 100+100+200
  expect(Object.keys(stats.uniqueArtists).sort()).toEqual(['A', 'B']);
  expect(aggregates.artistCounts.A).toEqual({ count: 2, artistId: 'ar-a' });
  expect(aggregates.artistCounts.B.count).toBe(1);
  expect(aggregates.albumCounts['AlbA::A']).toMatchObject({ artist: 'A', count: 2, albumId: 'al-a' });
  expect(aggregates.songCounts.s1.count).toBe(2);
  expect(aggregates.songCounts.s1.song.id).toBe('s1');
  expect(aggregates.genreCounts).toEqual({ Rock: 2, Jazz: 1 });
});

it('scopes aggregates to a period via sinceMs', async () => {
  insert('old', song('s1', { artist: 'A' }), NOW - 40 * DAY);
  insert('recent', song('s2', { artist: 'B' }), NOW - 2 * DAY);
  // sinceMs = 7 days before NOW → only the recent one.
  const { stats, aggregates } = await computeScrobbleAnalytics(NOW - 7 * DAY);
  expect(stats.totalPlays).toBe(1);
  expect(Object.keys(aggregates.artistCounts)).toEqual(['B']);
});

it('backfills derived columns for rows written before the columns existed', async () => {
  // An install that has not run the column drop: only id/song_json/time populated.
  createLegacyScrobbleTables(db());
  db().runSync('INSERT INTO scrobble_events (id, song_json, time) VALUES (?, ?, ?);', [
    'legacy',
    JSON.stringify(song('s9', { artist: 'Zed', album: 'AlbZ', duration: 50, genres: [{ name: 'Folk' }] as any })),
    NOW,
  ]);
  // Before backfill: aggregates ignore the NULL-column row.
  expect((await computeScrobbleAnalytics(0)).aggregates.artistCounts.Zed).toBeUndefined();

  await backfillScrobbleColumnsAsync();

  const { stats, aggregates } = await computeScrobbleAnalytics(0);
  expect(stats.totalPlays).toBe(1);
  expect(aggregates.artistCounts.Zed.count).toBe(1);
  expect(aggregates.genreCounts.Folk).toBe(1);
});

it('loadRecentScrobbles returns newest first, bounded', async () => {
  insert('a', song('s1'), NOW);
  insert('b', song('s2'), NOW + HOUR);
  insert('c', song('s3'), NOW + 2 * HOUR);
  const recent = await loadRecentScrobbles(2);
  expect(recent.map((r) => r.id)).toEqual(['c', 'b']); // newest first, limit 2
});
