/**
 * `fetch` with a hard time limit. A request that never gets an answer (a
 * stalled connection) otherwise waits for the operating system to give up,
 * which took roughly two hours and froze the whole SharePoint upload. The
 * caller's own abort signal still works.
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init?.signal
    ? AbortSignal.any([init.signal, timeout])
    : timeout;
  try {
    return await fetchImpl(input, { ...init, signal });
  } catch (error) {
    if (timeout.aborted && !init?.signal?.aborted) {
      throw new Error(`Request timed out after ${timeoutMs}ms.`);
    }
    throw error;
  }
}
