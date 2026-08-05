/**
 * `runAtomicBatchAsync` — the all-or-nothing bulk-write primitive.
 *
 * `runBatchAsync` is N statements in AUTOCOMMIT (op-SQLite leaves the transaction to
 * the caller), so a delete-then-insert rebuild that fails part-way leaves the delete
 * applied. These assert the SAVEPOINT bracketing, the rollback, and that the ORIGINAL
 * statement error is what callers see — including when the rollback itself fails, which
 * is what `SQLITE_FULL`/`IOERR`/`NOMEM` do (they abort the whole transaction, after
 * which `ROLLBACK TO` reports "no such savepoint").
 */
import { openDbConnection } from '../client';

import type { SQLBatchTuple } from '@op-engineering/op-sqlite';

function freshDb() {
  const conn = openDbConnection();
  conn.raw.executeSync('CREATE TABLE t (id TEXT PRIMARY KEY)');
  return conn;
}

const ids = (conn: ReturnType<typeof freshDb>): string[] =>
  conn.db.getAllSync<{ id: string }>('SELECT id FROM t ORDER BY id').map((r) => r.id);

describe('runAtomicBatchAsync', () => {
  it('brackets the caller commands in SAVEPOINT … RELEASE', async () => {
    const conn = freshDb();
    const spy = jest.spyOn(conn.raw, 'executeBatch');

    await conn.db.runAtomicBatchAsync([['INSERT INTO t VALUES (?)', ['a']]]);

    const sent = spy.mock.calls[0][0] as SQLBatchTuple[];
    expect(sent[0][0]).toBe('SAVEPOINT op_batch');
    expect(sent[sent.length - 1][0]).toBe('RELEASE op_batch');
    expect(sent).toHaveLength(3);
    expect(ids(conn)).toEqual(['a']);
    conn.raw.close();
  });

  it('issues executeBatch SYNCHRONOUSLY so a pipelining caller queues before it derives', () => {
    const conn = freshDb();
    const spy = jest.spyOn(conn.raw, 'executeBatch');

    void conn.db.runAtomicBatchAsync([['INSERT INTO t VALUES (?)', ['a']]]);

    // No await above: the batch must already be on the pool.
    expect(spy).toHaveBeenCalledTimes(1);
    conn.raw.close();
  });

  it('skips the connection entirely for an empty command list', async () => {
    const conn = freshDb();
    const spy = jest.spyOn(conn.raw, 'executeBatch');

    await conn.db.runAtomicBatchAsync([]);

    expect(spy).not.toHaveBeenCalled();
    conn.raw.close();
  });

  it('rolls the whole batch back on a mid-batch failure and rethrows the statement error', async () => {
    const conn = freshDb();
    await conn.db.runAtomicBatchAsync([['INSERT INTO t VALUES (?)', ['keep']]]);
    const spy = jest.spyOn(conn.raw, 'executeBatch');

    await expect(
      conn.db.runAtomicBatchAsync([
        ['DELETE FROM t', []],
        ['INSERT INTO t VALUES (?)', ['new']],
        ['INSERT INTO no_such_table VALUES (?)', ['boom']],
      ]),
    ).rejects.toThrow(/no_such_table/);

    // The DELETE and the INSERT both ran before the failure; only a real ROLLBACK TO
    // can put the previous row back.
    expect(ids(conn)).toEqual(['keep']);
    const recovery = spy.mock.calls[1][0] as SQLBatchTuple[];
    expect(recovery.map((c) => c[0])).toEqual(['ROLLBACK TO op_batch', 'RELEASE op_batch']);
    conn.raw.close();
  });

  it('leaves no open savepoint — the next write and a fresh BEGIN both succeed', async () => {
    const conn = freshDb();
    await expect(
      conn.db.runAtomicBatchAsync([['INSERT INTO no_such_table VALUES (?)', ['boom']]]),
    ).rejects.toThrow();

    // A stranded savepoint would make this BEGIN "cannot start a transaction within a
    // transaction" — the failure mode that takes `resetNormalizedSchema` down.
    conn.db.withTransactionSync(() => {
      conn.db.runSync('INSERT INTO t VALUES (?)', ['after']);
    });
    await conn.db.runAtomicBatchAsync([['INSERT INTO t VALUES (?)', ['after2']]]);

    expect(ids(conn)).toEqual(['after', 'after2']);
    conn.raw.close();
  });

  it('swallows a failing recovery and still reports the original error', async () => {
    const conn = freshDb();
    const original = new Error('disk is full');
    jest
      .spyOn(conn.raw, 'executeBatch')
      .mockRejectedValueOnce(original)
      .mockRejectedValueOnce(new Error('no such savepoint: op_batch'));

    await expect(
      conn.db.runAtomicBatchAsync([['INSERT INTO t VALUES (?)', ['a']]]),
    ).rejects.toBe(original);
    conn.raw.close();
  });
});
