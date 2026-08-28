import type { InternalDb } from '../../client';
import { keysetPage } from '../core';

interface Row {
  id: string;
  starred: number;
  sort_title: string;
}

/** Captures the SQL + params a read issues, without touching a real connection. */
function recordingDb(rows: Row[] = []): { db: InternalDb; sql: string[]; params: unknown[][] } {
  const sql: string[] = [];
  const params: unknown[][] = [];
  const db = {
    getAllAsync: async (s: string, p?: readonly unknown[]) => {
      sql.push(s);
      params.push([...(p ?? [])]);
      return rows;
    },
  } as unknown as InternalDb;
  return { db, sql, params };
}

describe('keysetPage direction', () => {
  it('ascending output is unchanged — `>` and a bare ORDER BY', async () => {
    const { db, sql, params } = recordingDb();
    await keysetPage<Row>(db, {
      table: 'songs',
      sortCol: 'sort_title',
      columns: '"id", "sort_title"',
      limit: 10,
      cursor: { sortKey: 'abba', id: 's1' },
      sortKeyOf: (r) => r.sort_title,
    });
    expect(sql[0]).toContain('("sort_title", "id") > (?, ?)');
    expect(sql[0]).toContain('ORDER BY "sort_title", "id" LIMIT ?');
    expect(sql[0]).not.toContain('DESC');
    expect(params[0]).toEqual(['abba', 's1', 11]);
  });

  it('descending flips the comparison AND every ORDER BY term', async () => {
    const { db, sql, params } = recordingDb();
    await keysetPage<Row>(db, {
      table: 'favorite_songs',
      sortCol: 'starred',
      columns: '"id", "starred"',
      direction: 'desc',
      limit: 5,
      cursor: { sortKey: 1700, id: 's9' },
      sortKeyOf: (r) => r.starred,
    });
    expect(sql[0]).toContain('("starred", "id") < (?, ?)');
    expect(sql[0]).toContain('ORDER BY "starred" DESC, "id" DESC LIMIT ?');
    expect(params[0]).toEqual([1700, 's9', 6]);
  });

  it('descending flips the compound key too', async () => {
    const { db, sql } = recordingDb();
    await keysetPage<Row>(db, {
      table: 'songs',
      sortCol: 'starred',
      sortCol2: 'sort_title',
      columns: '"id", "starred", "sort_title"',
      direction: 'desc',
      limit: 5,
      cursor: { sortKey: 1, sortKey2: 'x', id: 's1' },
      sortKeyOf: (r) => r.starred,
      sortKey2Of: (r) => r.sort_title,
    });
    expect(sql[0]).toContain('("starred", "sort_title", "id") < (?, ?, ?)');
    expect(sql[0]).toContain('ORDER BY "starred" DESC, "sort_title" DESC, "id" DESC');
  });

  it('returns a numeric cursor key for an integer sort column', async () => {
    const rows: Row[] = Array.from({ length: 3 }, (_, i) => ({
      id: `s${i}`,
      starred: 100 - i,
      sort_title: 'x',
    }));
    const { db } = recordingDb(rows);
    const page = await keysetPage<Row>(db, {
      table: 'favorite_songs',
      sortCol: 'starred',
      columns: '"id", "starred"',
      direction: 'desc',
      limit: 2,
      sortKeyOf: (r) => r.starred,
    });
    expect(page.rows).toHaveLength(2);
    expect(page.nextCursor).toEqual({ sortKey: 99, id: 's1', sortKey2: undefined });
  });

  it('rejects `letter` alongside `direction: desc` at the type level', async () => {
    const { db } = recordingDb();
    const opts = {
      table: 'favorite_songs',
      sortCol: 'starred',
      columns: '"id", "starred"',
      direction: 'desc' as const,
      limit: 5,
      letter: 'A',
      sortKeyOf: (r: Row) => r.starred,
    };
    // @ts-expect-error `letter` seeks `sortCol >= ?`, an ascending-only boundary that a
    // descending ORDER BY would silently pair with the wrong page.
    await keysetPage<Row>(db, opts);
  });
});
