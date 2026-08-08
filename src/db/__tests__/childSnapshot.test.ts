import type { Child } from 'subsonic-api';

import { promotedSongFieldsFromChild } from '@/store/persistence/musicCacheTables';

import {
  childFromSnapshotRow,
  childGenreNames,
  childSnapshotArrayCommands,
  childSnapshotFields,
  type ChildSnapshotArrays,
  type ChildSnapshotRow,
} from '../childSnapshot';

const CREATED = new Date('2021-03-04T05:06:07.000Z');
const STARRED = new Date('2022-07-08T09:10:11.000Z');

/** Every field the snapshot covers, plus the five whose names collide with
 *  `cached_songs`' file-on-disk columns, plus all five arrays. */
const richChild: Child = {
  id: 's1',
  title: 'Title',
  isDir: false,
  artist: 'Artist',
  album: 'Album',
  coverArt: 'ca-1',
  duration: 214,
  // The five whose names `cached_songs` has to rename to `src_*`.
  albumId: 'al-1',
  suffix: 'flac',
  bitRate: 1411,
  bitDepth: 24,
  samplingRate: 96000,
  artistId: 'ar-1',
  displayArtist: 'Artist feat. Other',
  displayAlbumArtist: 'Album Artist',
  displayComposer: 'Composer',
  track: 3,
  discNumber: 1,
  year: 1999,
  genre: 'Jazz',
  size: 12345678,
  contentType: 'audio/flac',
  transcodedContentType: 'audio/mpeg',
  transcodedSuffix: 'mp3',
  channelCount: 2,
  path: 'Artist/Album/03 Title.flac',
  userRating: 4,
  averageRating: 4.5,
  playCount: 12,
  created: CREATED,
  starred: STARRED,
  played: '2023-01-02T03:04:05.000Z',
  type: 'music',
  bpm: 120,
  comment: 'a comment',
  sortName: 'Title, The',
  musicBrainzId: 'mb-1',
  explicitStatus: 'clean',
  bookmarkPosition: 4200,
  isVideo: false,
  parent: 'p-1',
  originalWidth: 640,
  originalHeight: 480,
  genres: ['Jazz', 'Fusion'],
  moods: ['calm', 'late night'],
  artists: [{ id: 'ar-1', name: 'Artist', albumCount: 7 }],
  albumArtists: [{ id: 'ar-2', name: 'Album Artist', albumCount: 3 }],
  contributors: [
    { role: 'producer', subRole: 'exec', artist: { id: 'ar-3', name: 'Producer', albumCount: 1 } },
    { role: 'engineer' },
  ],
  replayGain: {
    trackGain: -7.1,
    albumGain: -6.2,
    trackPeak: 0.98,
    albumPeak: 0.99,
    baseGain: -1.5,
    fallbackGain: -2.5,
  },
};

/** What the five child tables give back for {@link richChild}, in `pos` order. */
const richArrays: ChildSnapshotArrays = {
  genres: ['Jazz', 'Fusion'],
  artists: [{ artistId: 'ar-1', artistName: 'Artist' }],
  albumArtists: [{ artistId: 'ar-2', artistName: 'Album Artist' }],
  contributors: [
    { role: 'producer', subRole: 'exec', artistId: 'ar-3', artistName: 'Producer' },
    { role: 'engineer', subRole: null, artistId: null, artistName: null },
  ],
  moods: ['calm', 'late night'],
};

/** The core columns each consumer stores under its own key, alongside the shared
 *  fields — together they are the stored row. */
const rowFor = (child: Child): ChildSnapshotRow => ({
  id: child.id,
  title: child.title,
  artist: child.artist,
  album: child.album,
  coverArt: child.coverArt,
  duration: child.duration,
  ...childSnapshotFields(child),
});

describe('childGenreNames', () => {
  it('accepts plain strings and OpenSubsonic `{name}` objects, dropping empties', () => {
    expect(childGenreNames({ id: 'x', title: 'x', isDir: false, genres: ['Jazz', ''] })).toEqual([
      'Jazz',
    ]);
    const objectGenres = [{ name: 'Rock' }, { name: '' }, null] as unknown as string[];
    expect(
      childGenreNames({ id: 'x', title: 'x', isDir: false, genres: objectGenres }),
    ).toEqual(['Rock']);
  });

  it('returns an empty array when the field is absent', () => {
    expect(childGenreNames({ id: 'x', title: 'x', isDir: false })).toEqual([]);
  });
});

describe('childSnapshotFields', () => {
  it('carries the five colliding `Child` fields under their natural names', () => {
    const fields = childSnapshotFields(richChild);
    expect(fields.albumId).toBe('al-1');
    expect(fields.suffix).toBe('flac');
    expect(fields.bitRate).toBe(1411);
    expect(fields.bitDepth).toBe(24);
    expect(fields.samplingRate).toBe(96000);
  });

  it('never emits the file facts, the `src_*` twins, the arrays or the core columns', () => {
    const fields = childSnapshotFields(richChild) as Record<string, unknown>;
    for (const key of [
      // Facts about the downloaded file — not `Child` data at all.
      'bytes',
      'formatCapturedAt',
      'downloadedAt',
      // `cached_songs`' renaming, applied at that table's boundary.
      'srcAlbumId',
      'srcSuffix',
      'srcBitRate',
      'srcBitDepth',
      'srcSamplingRate',
      // The arrays belong to `childSnapshotArrayCommands`.
      'genres',
      'artists',
      'albumArtists',
      'contributors',
      'moods',
      'replayGain',
      // The core columns each consumer holds under its own key.
      'id',
      'title',
      'artist',
      'album',
      'coverArt',
      'duration',
    ]) {
      expect(key in fields).toBe(false);
    }
  });

  // The guard that protects `resolveSongFile`: a server value must never reach
  // `cached_songs.album_id`/`suffix`/`bit_rate`/`bit_depth`/`sampling_rate`.
  it('reaches `cached_songs` only through the `src_*` rename', () => {
    const promoted = promotedSongFieldsFromChild(richChild) as Record<string, unknown>;
    for (const key of ['albumId', 'suffix', 'bitRate', 'bitDepth', 'samplingRate']) {
      expect(key in promoted).toBe(false);
    }
    expect(promoted.srcAlbumId).toBe('al-1');
    expect(promoted.srcSuffix).toBe('flac');
    expect(promoted.srcBitRate).toBe(1411);
    expect(promoted.srcBitDepth).toBe(24);
    expect(promoted.srcSamplingRate).toBe(96000);
  });

  it('flattens replayGain to `rg_*` and stores the dates as epoch ms', () => {
    const fields = childSnapshotFields(richChild);
    expect(fields.rgTrackGain).toBe(-7.1);
    expect(fields.rgAlbumGain).toBe(-6.2);
    expect(fields.rgTrackPeak).toBe(0.98);
    expect(fields.rgAlbumPeak).toBe(0.99);
    expect(fields.rgBaseGain).toBe(-1.5);
    expect(fields.rgFallbackGain).toBe(-2.5);
    expect(fields.created).toBe(CREATED.getTime());
    expect(fields.starred).toBe(STARRED.getTime());
  });

  it('accepts a date as an ISO string or an epoch number, and drops an unparseable one', () => {
    const withDate = (created: unknown): Child =>
      ({ id: 's', title: 't', isDir: false, created } as Child);
    expect(childSnapshotFields(withDate('2021-03-04T05:06:07.000Z')).created).toBe(
      CREATED.getTime(),
    );
    expect(childSnapshotFields(withDate(1234)).created).toBe(1234);
    expect(childSnapshotFields(withDate('not a date')).created).toBeUndefined();
    expect(childSnapshotFields(withDate(null)).created).toBeUndefined();
  });

  it('leaves every field undefined for a bare Child', () => {
    const fields = childSnapshotFields({ id: 's2', title: 'T', isDir: true });
    expect(fields.isDir).toBe(true);
    expect(Object.values(fields).filter((v) => v !== undefined)).toEqual([true]);
  });
});

describe('childSnapshotArrayCommands', () => {
  const commands = (child: Child, tablePrefix = 'cached_song'): Array<[string, unknown[]]> =>
    childSnapshotArrayCommands({
      tablePrefix,
      keyColumn: 'song_id',
      keyValue: 's1',
      child,
    }).map(([sql, params]) => [sql.replace(/\s+/g, ' ').trim(), [...params]]);

  it('deletes all five tables before inserting, so a shrunk array leaves no tail rows', () => {
    const deletes = commands(richChild).slice(0, 5);
    expect(deletes).toEqual([
      ['DELETE FROM cached_song_genres WHERE song_id = ?;', ['s1']],
      ['DELETE FROM cached_song_artists WHERE song_id = ?;', ['s1']],
      ['DELETE FROM cached_song_album_artists WHERE song_id = ?;', ['s1']],
      ['DELETE FROM cached_song_contributors WHERE song_id = ?;', ['s1']],
      ['DELETE FROM cached_song_moods WHERE song_id = ?;', ['s1']],
    ]);
  });

  it('inserts every array element at its position', () => {
    expect(commands(richChild).slice(5)).toEqual([
      ['INSERT INTO cached_song_genres (song_id, pos, name) VALUES (?, ?, ?);', ['s1', 0, 'Jazz']],
      ['INSERT INTO cached_song_genres (song_id, pos, name) VALUES (?, ?, ?);', ['s1', 1, 'Fusion']],
      [
        'INSERT INTO cached_song_artists (song_id, pos, artist_id, artist_name) VALUES (?, ?, ?, ?);',
        ['s1', 0, 'ar-1', 'Artist'],
      ],
      [
        'INSERT INTO cached_song_album_artists (song_id, pos, artist_id, artist_name) VALUES (?, ?, ?, ?);',
        ['s1', 0, 'ar-2', 'Album Artist'],
      ],
      [
        'INSERT INTO cached_song_contributors (song_id, pos, role, sub_role, artist_id, artist_name) VALUES (?, ?, ?, ?, ?, ?);',
        ['s1', 0, 'producer', 'exec', 'ar-3', 'Producer'],
      ],
      [
        'INSERT INTO cached_song_contributors (song_id, pos, role, sub_role, artist_id, artist_name) VALUES (?, ?, ?, ?, ?, ?);',
        ['s1', 1, 'engineer', null, null, null],
      ],
      ['INSERT INTO cached_song_moods (song_id, pos, mood) VALUES (?, ?, ?);', ['s1', 0, 'calm']],
      [
        'INSERT INTO cached_song_moods (song_id, pos, mood) VALUES (?, ?, ?);',
        ['s1', 1, 'late night'],
      ],
    ]);
  });

  it('emits the deletes alone when the Child carries no arrays', () => {
    expect(commands({ id: 's1', title: 'T', isDir: false })).toHaveLength(5);
  });

  it('derives all five table names from the prefix', () => {
    expect(commands(richChild, 'snap').map(([sql]) => sql.split(' ')[2])).toEqual(
      expect.arrayContaining([
        'snap_genres',
        'snap_artists',
        'snap_album_artists',
        'snap_contributors',
        'snap_moods',
      ]),
    );
  });
});

describe('childFromSnapshotRow', () => {
  it('round-trips a rich Child through the fields and the five arrays', () => {
    const back = childFromSnapshotRow(rowFor(richChild), richArrays);
    expect(back).toEqual({
      ...richChild,
      // The mirrors keep identity only — `albumCount` is mutable artist state.
      artists: [{ id: 'ar-1', name: 'Artist', albumCount: 0 }],
      albumArtists: [{ id: 'ar-2', name: 'Album Artist', albumCount: 0 }],
      contributors: [
        { role: 'producer', subRole: 'exec', artist: { id: 'ar-3', name: 'Producer', albumCount: 0 } },
        { role: 'engineer' },
      ],
    });
    expect(back.created).toBeInstanceOf(Date);
    expect(back.created?.getTime()).toBe(CREATED.getTime());
    expect(back.starred?.getTime()).toBe(STARRED.getTime());
  });

  it('restores the fields `resolveSongCoverArt` and the details modal read', () => {
    const back = childFromSnapshotRow(rowFor(richChild), richArrays);
    expect(back.albumId).toBe('al-1');
    expect(back.suffix).toBe('flac');
    expect(back.bitRate).toBe(1411);
    expect(back.bitDepth).toBe(24);
    expect(back.samplingRate).toBe(96000);
  });

  it('leaves absent columns and empty arrays off the reconstructed Child', () => {
    const bare: Child = { id: 's2', title: 'T', isDir: true };
    expect(childFromSnapshotRow(rowFor(bare), {})).toEqual(bare);
    expect(
      childFromSnapshotRow(rowFor(bare), {
        genres: [],
        artists: [],
        albumArtists: [],
        contributors: [],
        moods: [],
      }),
    ).toEqual(bare);
  });

  it('defaults isDir to false when the column is NULL', () => {
    expect(childFromSnapshotRow({ id: 's3', title: 'T' }, {}).isDir).toBe(false);
  });

  it('rebuilds a partial replayGain and omits it entirely when no `rg_*` column is set', () => {
    expect(childFromSnapshotRow({ id: 's4', title: 'T', rgTrackGain: -3 }, {}).replayGain).toEqual({
      trackGain: -3,
    });
    expect('replayGain' in childFromSnapshotRow({ id: 's4', title: 'T' }, {})).toBe(false);
  });

  it('keeps a contributor whose mirror row carries only a name', () => {
    const { contributors } = childFromSnapshotRow(
      { id: 's5', title: 'T' },
      { contributors: [{ role: 'composer', artistName: 'Nameless Id' }] },
    );
    expect(contributors).toEqual([
      { role: 'composer', artist: { id: '', name: 'Nameless Id', albumCount: 0 } },
    ]);
  });
});
