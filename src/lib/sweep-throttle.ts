/**
 * Returns a function that answers "may the work run now?": true on the first
 * call and then at most once per `intervalMs`. Blocked calls do not push the
 * next allowed time back.
 */
export function createThrottle(
  intervalMs: number,
  now: () => number = Date.now,
): () => boolean {
  let lastRun: number | null = null;
  return () => {
    const current = now();
    if (lastRun !== null && current - lastRun < intervalMs) return false;
    lastRun = current;
    return true;
  };
}
