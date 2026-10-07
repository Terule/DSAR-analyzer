/**
 * How many Files workers the dispatcher runs in parallel. Each worker is one
 * container limited to about 1.5GB and one CPU core, so the ceiling is chosen to
 * stay inside a 14GB Docker allocation next to the app (about 4GB) even if every
 * worker hits its limit.
 */
export const FILES_CONCURRENCY_LIMITS = {
  min: 1,
  max: 8,
  default: 6,
} as const;

/** Coerces any stored or supplied value into the allowed range. */
export function clampFilesConcurrency(
  value: number | null | undefined,
): number {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return FILES_CONCURRENCY_LIMITS.default;
  }
  return Math.min(
    FILES_CONCURRENCY_LIMITS.max,
    Math.max(FILES_CONCURRENCY_LIMITS.min, Math.floor(value)),
  );
}

/** True for a whole number inside the allowed range. */
export function isValidFilesConcurrency(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= FILES_CONCURRENCY_LIMITS.min &&
    value <= FILES_CONCURRENCY_LIMITS.max
  );
}
