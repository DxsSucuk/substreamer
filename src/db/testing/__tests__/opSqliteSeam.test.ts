/**
 * Phase 0.5 proof: the op-SQLite ⇄ better-sqlite3 test seam runs REAL SQL and
 * faithfully models the op-SQLite semantics the persistence rebuild relies on —
 * async/sync execute, keyset pagination, atomic transactions, and reactive
 * queries that fire on transaction commit. This is the shared backend every
 * DB-touching suite will use once the new client lands.
 */
import { open } from '@op-engineering/op-sqlite';

jest.mock('@op-engineering/op-sqlite', () =>
  require('../opSqliteBetterSqlite3').createOpSqliteMock());

const memory = () => open({ name: 'test.db', location: ':memory:' });

describe('op-SQLite ⇄ better-sqlite3 test seam', () => {
  it('runs real SQL: create / insert / select (async + sync)', async () => {
    const db = memory();
    await db.execute('CREATE TABLE songs (id TEXT PRIMARY KEY, title TEXT, starred INTEGER)');
    await db.execute('INSERT INTO songs (id, title, starred) VALUES (?, ?, ?)', ['s1', 'Alpha', null]);
    await db.execute('INSERT INTO songs (id, title, starred) VALUES (?, ?, ?)', ['s2', 'Bravo', 1]);

    const all = await db.execute('SELECT id, title FROM songs ORDER BY title');
    expect(all.rows.map((r) => r.id)).toEqual(['s1', 's2']);
    expect(all.columnNames).toEqual(['id', 'title']);

    const count = db.executeSync('SELECT COUNT(*) AS n FROM songs');
    expect(count.rows[0].n).toBe(2);

    // the favorites-filter shape the list relies on
    const starred = await db.execute('SELECT id FROM songs WHERE starred IS NOT NULL');
    expect(starred.rows).toEqual([{ id: 's2' }]);
    db.close();
  });

  it('keyset pagination: WHERE (title, id) > (?, ?) seeks the next page', async () => {
    const db = memory();
    await db.execute('CREATE TABLE songs (id TEXT PRIMARY KEY, title TEXT)');
    for (const [id, title] of [['a', 'Apple'], ['b', 'Banana'], ['c', 'Cherry'], ['d', 'Date']]) {
      await db.execute('INSERT INTO songs VALUES (?, ?)', [id, title]);
    }
    const page1 = await db.execute('SELECT id, title FROM songs ORDER BY title, id LIMIT 2');
    expect(page1.rows.map((r) => r.title)).toEqual(['Apple', 'Banana']);

    const last = page1.rows[page1.rows.length - 1];
    const page2 = await db.execute(
      'SELECT id, title FROM songs WHERE (title, id) > (?, ?) ORDER BY title, id LIMIT 2',
      [last.title, last.id],
    );
    expect(page2.rows.map((r) => r.title)).toEqual(['Cherry', 'Date']);
    db.close();
  });

  it('transactions commit atomically and roll back on error', async () => {
    const db = memory();
    await db.execute('CREATE TABLE t (id TEXT PRIMARY KEY)');
    await db.transaction(async (tx) => {
      await tx.execute('INSERT INTO t VALUES (?)', ['x']);
      await tx.execute('INSERT INTO t VALUES (?)', ['y']);
    });
    expect((await db.execute('SELECT COUNT(*) AS n FROM t')).rows[0].n).toBe(2);

    await expect(
      db.transaction(async (tx) => {
        await tx.execute('INSERT INTO t VALUES (?)', ['z']);
        await tx.execute('INSERT INTO t VALUES (?)', ['x']); // PK conflict → rollback
      }),
    ).rejects.toBeTruthy();
    // 'z' was rolled back with the failed transaction
    expect((await db.execute('SELECT COUNT(*) AS n FROM t')).rows[0].n).toBe(2);
    db.close();
  });

  it('reactiveExecute fires on transaction commit; unsub disposes', async () => {
    const db = memory();
    await db.execute('CREATE TABLE songs (id TEXT PRIMARY KEY, title TEXT)');
    const seen: number[] = [];
    const unsub = db.reactiveExecute({
      query: 'SELECT COUNT(*) AS n FROM songs',
      arguments: [],
      fireOn: [{ table: 'songs' }],
      callback: (res) => seen.push(res.rows[0].n as number),
    });

    await db.transaction(async (tx) => {
      await tx.execute('INSERT INTO songs VALUES (?, ?)', ['s1', 'Alpha']);
    });
    expect(seen).toEqual([1]);

    await db.transaction(async (tx) => {
      await tx.execute('INSERT INTO songs VALUES (?, ?)', ['s2', 'Bravo']);
    });
    expect(seen).toEqual([1, 2]);

    unsub();
    await db.transaction(async (tx) => {
      await tx.execute('INSERT INTO songs VALUES (?, ?)', ['s3', 'Charlie']);
    });
    expect(seen).toEqual([1, 2]); // no fire after dispose
    db.close();
  });

  it('reactive queries do NOT fire on bare writes, only after flush (op-SQLite semantics)', async () => {
    const db = memory();
    await db.execute('CREATE TABLE songs (id TEXT PRIMARY KEY)');
    const seen: number[] = [];
    db.reactiveExecute({
      query: 'SELECT COUNT(*) AS n FROM songs',
      arguments: [],
      fireOn: [{ table: 'songs' }],
      callback: (res) => seen.push(res.rows[0].n as number),
    });
    // write outside a transaction — must NOT fire yet
    await db.execute('INSERT INTO songs VALUES (?)', ['s1']);
    expect(seen).toEqual([]);
    // Drizzle-style non-transactional writes require an explicit flush
    await db.flushPendingReactiveQueries();
    expect(seen).toEqual([1]);
    db.close();
  });

  it('a batch is deferred a macrotask; a read issued after it runs FIRST', async () => {
    const db = memory();
    await db.execute('CREATE TABLE albums (id TEXT PRIMARY KEY)');

    const write = db.executeBatch([['INSERT INTO albums VALUES (?)', ['a1']]]);
    // Same tick as the un-awaited batch: the row is not there yet.
    expect((await db.execute('SELECT COUNT(*) AS n FROM albums')).rows[0].n).toBe(0);

    await write;
    expect((await db.execute('SELECT COUNT(*) AS n FROM albums')).rows[0].n).toBe(1);
    db.close();
  });

  it('batches run in submission order, one at a time, behind bare writes', async () => {
    const db = memory();
    await db.execute('CREATE TABLE log (seq INTEGER PRIMARY KEY AUTOINCREMENT, tag TEXT)');

    const first = db.executeBatch([['INSERT INTO log (tag) VALUES (?)', ['batch-1']]]);
    const second = db.executeBatch([['INSERT INTO log (tag) VALUES (?)', ['batch-2']]]);
    await db.execute('INSERT INTO log (tag) VALUES (?)', ['bare']);
    await Promise.all([first, second]);

    expect((await db.execute('SELECT tag FROM log ORDER BY seq')).rows.map((r) => r.tag)).toEqual([
      'bare',
      'batch-1',
      'batch-2',
    ]);
    db.close();
  });

  it('id-sorted batch insert (the bulk-sync write path) lands every row', async () => {
    const db = memory();
    await db.execute('CREATE TABLE albums (id TEXT PRIMARY KEY, name TEXT)');
    const rows: [string, string[]][] = [
      ['INSERT INTO albums (id, name) VALUES (?, ?)', ['a1', 'One']],
      ['INSERT INTO albums (id, name) VALUES (?, ?)', ['a2', 'Two']],
      ['INSERT INTO albums (id, name) VALUES (?, ?)', ['a3', 'Three']],
    ];
    const res = await db.executeBatch(rows);
    expect(res.rowsAffected).toBe(3);
    expect((await db.execute('SELECT COUNT(*) AS n FROM albums')).rows[0].n).toBe(3);
    db.close();
  });
});
