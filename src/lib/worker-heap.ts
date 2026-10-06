/** Largest share of a container's memory V8's heap may claim. */
const MAX_HEAP_SHARE = 0.85;

/**
 * The `--max-old-space-size` flag for a worker, or null to leave Node's own
 * default alone. Node sizes its default heap at about half the container's
 * memory, which a render with a large spreadsheet attachment can exhaust long
 * before the container does. A configured value is clamped to 85% of the
 * container limit so a typo can't make the container OOM-kill the worker.
 */
export function heapOption(
  containerMb: number,
  configuredMb: string | undefined,
): string | null {
  const requested = Number(configuredMb);
  if (!configuredMb?.trim() || !Number.isFinite(requested) || requested <= 0) {
    return null;
  }
  const heap = Math.floor(Math.min(requested, containerMb * MAX_HEAP_SHARE));
  return `--max-old-space-size=${heap}`;
}
