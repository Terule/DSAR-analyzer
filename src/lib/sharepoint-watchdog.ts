/**
 * A running upload worker renews its database lease every file. If work is
 * waiting and the lease lapsed well beyond its normal expiry, the worker is
 * alive but stuck, so it should be restarted.
 */
export function uploadWorkerHung(input: {
  pending: number;
  leaseUntilMs: number | null;
  now: number;
  graceMs: number;
}): boolean {
  if (input.pending <= 0 || input.leaseUntilMs === null) return false;
  return input.now - input.leaseUntilMs > input.graceMs;
}
