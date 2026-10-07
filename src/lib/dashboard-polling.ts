interface PollRequest {
  status: string;
  phaseProgress?: Record<string, { status: string } | undefined>;
}

// A phase in one of these states is doing work right now.
const ACTIVE_PHASE = ["processing", "batch_ready", "extracting", "analyzed"];

/**
 * Whether the dashboard should keep refreshing. A request's own status is not
 * enough: a request that finished wave 1 reads "completed" while a retried or
 * continued step is working, and a page that stopped polling kept showing that
 * step's old "Failed" state.
 */
export function needsPolling(
  cases: Array<{ requests: PollRequest[] }>,
): boolean {
  return cases.some((item) =>
    item.requests.some(
      (request) =>
        ["queued", "running"].includes(request.status) ||
        Object.values(request.phaseProgress ?? {}).some(
          (phase) => phase !== undefined && ACTIVE_PHASE.includes(phase.status),
        ),
    ),
  );
}
