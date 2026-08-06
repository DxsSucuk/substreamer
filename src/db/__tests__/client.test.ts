/**
 * `runAtomicBatchAsync` — the all-or-nothing bulk-write primitive.
 *
 * `runBatchAsync` is N statements in AUTOCOMMIT (op-SQLite leaves the transaction to
 * the caller), so a delete-then-insert rebuild that fails part-way leaves the delete
 * applied. These assert the SAVEPOINT bracketing, the rollback, and that the ORIGINAL
 * statement error is what callers see — including when the rollback itself fails, which
 * is what `SQLITE_FULL`/`IOERR`/`NOMEM` do (they abort the whole transaction, after
 * which `ROLLBACK TO` reports "no such savepoint").
 *
 * They also pin the ORDER the two batches are issued in. An aborted batch never reaches
 * its RELEASE, so recovering from the JS `catch` would leave the savepoint open across a
 * round trip to JS and let the pool commit other writers' work inside it, to be discarded
 * by the ROLLBACK. The recovery is therefore enqueued unconditionally in the same tick —
 * on the success path it is a no-op that fails with "no such savepoint". The seam runs
 * `executeBatch` synchronously (no pool, no window), so only that ordering is checkable
 * here; the hazard itself is device-only.
 */
import { awaitDbWritesIdle, openDbConnection } from '../client';

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

  it('issues BOTH batches SYNCHRONOUSLY so nothing can be queued between them', () => {
    const conn = freshDb();
    const spy = jest.spyOn(conn.raw, 'executeBatch');

    void conn.db.runAtomicBatchAsync([['INSERT INTO t VALUES (?)', ['a']]]);

    // No await above: the batch must already be on the pool (the pipelining caller
    // `bulkUpsert` derives its next chunk before this one would otherwise land), and
    // the recovery must be on it too — one JS thread means nothing can be issued
    // between two synchronous calls, so there is no window to be captured by.
    expect(spy).toHaveBeenCalledTimes(2);
    expect((spy.mock.calls[1][0] as SQLBatchTuple[]).map((c) => c[0])).toEqual([
      'ROLLBACK TO op_batch',
      'RELEASE op_batch',
    ]);
    conn.raw.close();
  });

  it('enqueues the recovery even when the batch SUCCEEDS, and it undoes nothing', async () => {
    const conn = freshDb();
    const spy = jest.spyOn(conn.raw, 'executeBatch');

    await conn.db.runAtomicBatchAsync([['INSERT INTO t VALUES (?)', ['a']]]);

    // The successful batch already released the savepoint, so the recovery's
    // `ROLLBACK TO` fails with "no such savepoint" — expected, swallowed, and the row
    // stays committed. Moving the recovery back under the `catch` would pass every
    // other test in this file and silently reopen the window.
    expect(spy).toHaveBeenCalledTimes(2);
    expect(ids(conn)).toEqual(['a']);
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

  it('counts the recovery as in-flight, so idle means the pool really is quiet', async () => {
    const conn = freshDb();
    let finishRecovery!: (r: unknown) => void;
    const pending = new Promise((resolve) => {
      finishRecovery = resolve;
    });
    jest
      .spyOn(conn.raw, 'executeBatch')
      .mockReturnValueOnce(Promise.resolve({ rowsAffected: 1 }))
      .mockReturnValueOnce(pending as never);

    await conn.db.runAtomicBatchAsync([['INSERT INTO t VALUES (?)', ['a']]]);
    const idle = awaitDbWritesIdle().then(() => 'idle');
    const waiting = Symbol('waiting');
    expect(await Promise.race([idle, Promise.resolve(waiting)])).toBe(waiting);

    finishRecovery({ rowsAffected: 0 });
    expect(await idle).toBe('idle');
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

/**
 * The quiesce logout waits on before its JS-thread `BEGIN`. It TRACKS writes rather
 * than serializing them, and it replaced a drain of the `serializeDbWrite` chain that
 * could only ever see the writers which had opted into that chain.
 */
describe('awaitDbWritesIdle', () => {
  it('resolves immediately when nothing is in flight', async () => {
    await expect(awaitDbWritesIdle()).resolves.toBeUndefined();
  });

  it('does not resolve while a write is outstanding', async () => {
    const conn = freshDb();
    let finish!: (r: unknown) => void;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    jest.spyOn(conn.raw, 'execute').mockReturnValueOnce(pending as never);

    const write = conn.db.runAsync('INSERT INTO t VALUES (?)', ['a']);
    const idle = awaitDbWritesIdle().then(() => 'idle');
    const waiting = Symbol('waiting');
    expect(await Promise.race([idle, Promise.resolve(waiting)])).toBe(waiting);

    finish({ rows: [], rowsAffected: 1, insertId: 0 });
    await write;
    expect(await idle).toBe('idle');
    conn.raw.close();
  });

  it('resolves after an in-flight write REJECTS — a failed write must not hang logout', async () => {
    const conn = freshDb();
    let fail!: (e: Error) => void;
    const pending = new Promise((_resolve, reject) => {
      fail = reject;
    });
    jest.spyOn(conn.raw, 'execute').mockReturnValueOnce(pending as never);

    const write = conn.db.runAsync('INSERT INTO t VALUES (?)', ['a']);
    const idle = awaitDbWritesIdle();
    fail(new Error('disk is full'));

    await expect(write).rejects.toThrow('disk is full');
    await expect(idle).resolves.toBeUndefined();
    conn.raw.close();
  });
});
