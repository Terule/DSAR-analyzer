function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Next.js's dev server hot-reloads every open page when any watched file
 * changes. The worker data folders (`logs/`, `batches/`) are bind-mounted into
 * the project and are written to on every AI batch result, which refreshed the
 * dashboard each time. Next freezes its default `watchOptions`, so build a new
 * object whose `ignored` regexp is Next's own rule OR the data folders.
 *
 * @param {{ ignored?: unknown } | undefined} watchOptions
 * @param {string} root absolute project root
 * @param {string[]} dataDirs top-level folders directly under `root`
 */
export function withDataDirsIgnored(watchOptions, root, dataDirs) {
  const normalizedRoot = root.split("\\").join("/").replace(/\/$/, "");
  const names = dataDirs.map(escapeRegExp).join("|");
  const dataDirsRule = `^${escapeRegExp(normalizedRoot)}/(?:${names})(?:/|$)`;
  const existing = watchOptions?.ignored;
  const source =
    existing instanceof RegExp
      ? `${existing.source}|${dataDirsRule}`
      : dataDirsRule;
  return { ...watchOptions, ignored: new RegExp(source) };
}
