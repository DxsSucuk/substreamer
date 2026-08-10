/**
 * Drain op-SQLite's transaction lock so fire-and-forget writes have landed.
 *
 * A batch does not reach the engine when it is called: the seam parks it on the lock
 * and starts it from a `setImmediate`, one at a time, exactly as op-SQLite's
 * `enhanceDB` does (`src/db/testing/opSqliteBetterSqlite3.ts`). So N un-awaited
 * writes need N macrotasks, and a single `setTimeout(0)` settles only the first —
 * awaiting the write is what production does, and this is for the tests that
 * deliberately assert on an un-awaited one.
 *
 * Jest's fake timers fake `setImmediate` too, and `advanceTimersByTimeAsync(0)` fires
 * only the immediates that were already pending — never one the fired callback
 * scheduled, because the clock has not moved past it. Draining a chain therefore
 * costs 1ms of fake clock per macrotask. A suite that cannot afford that should fake
 * everything EXCEPT the lock: `jest.useFakeTimers({ doNotFake: ['setImmediate'] })`.
 */
const setImmediateIsFaked = (): boolean =>
  (setImmediate as unknown as { clock?: unknown }).clock !== undefined;

export async function settleDbWrites(macrotasks = 50): Promise<void> {
  for (let i = 0; i < macrotasks; i++) {
    if (setImmediateIsFaked()) {
      // eslint-disable-next-line no-await-in-loop
      await jest.advanceTimersByTimeAsync(1);
    } else {
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
}
