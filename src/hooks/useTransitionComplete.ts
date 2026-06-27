import { useEffect, useState } from 'react';

import { runWhenIdle } from '../utils/runWhenIdle';

/**
 * Defer heavy rendering until the JS thread is idle (e.g. after a navigation
 * transition animation completes). Returns `true` once the idle window fires
 * (or the safety-net timeout elapses, so it can never stay false forever).
 *
 * If `skip` is true the hook returns `true` immediately (useful when there
 * is no cached data and you want to render the loading state right away).
 */
export function useTransitionComplete(skip = false): boolean {
  const [complete, setComplete] = useState(skip);

  useEffect(() => {
    if (skip) return;
    return runWhenIdle(() => {
      setComplete(true);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return complete;
}
