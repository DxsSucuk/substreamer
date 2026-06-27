import { errMessage } from './errorMessage';
/**
 * Fire-and-forget a promise without silent rejections.
 *
 * Prefer this over a bare `void p` at every call site where a service
 * action is intentionally not awaited (deferred startup fan-out, nested
 * continuations, trust-store installers). If the underlying action is
 * ever refactored to throw, the rejection logs with a tag rather than
 * disappearing into "Possible Unhandled Promise Rejection".
 */
export function fireAndForget<T>(
  promise: Promise<T>,
  tag: string,
): void {
  promise.catch((e) => {
    // eslint-disable-next-line no-console
    console.warn(
      `[fireAndForget:${tag}]`,
      errMessage(e),
    );
  });
}
