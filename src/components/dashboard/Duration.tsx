export function Duration({ ms }: { ms?: number }) {
  if (!ms || ms === 0) return <span>-</span>;
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  if (mins > 0)
    return (
      <span>
        {mins}m {secs}s
      </span>
    );
  return <span>{secs}s</span>;
}
