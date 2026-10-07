/**
 * `fetch` with a hard time limit. A request that never gets an answer (a
 * stalled connection) otherwise waits for the operating system to give up,
 * which took roughly two hours and froze the whole SharePoint upload. The
 * caller's own abort signal still works.
 *
 * The timer is an ordinary one (not `AbortSignal.timeout`, which does not keep
 * the process alive while it waits). Once the response arrives it is unref'd:
 * it still aborts a stalled response body, but never delays a clean exit.
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const controller = new AbortController();
  const callerSignal = init?.signal ?? undefined;
  const onCallerAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) controller.abort(callerSignal.reason);
  else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetchImpl(input, {
      ...init,
      signal: controller.signal,
    });
    timer.unref();
    return response;
  } catch (error) {
    clearTimeout(timer);
    if (timedOut && !callerSignal?.aborted) {
      throw new Error(`Request timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}
