/**
 * Request statistics, built from every wave's rows so a request that was
 * continued reports everything it ever did, not just the latest wave.
 *
 * Mail funnel:   scanned = duplicates + unique;  unique = excluded + selected.
 * Files funnel:  found = delivered + skipped;    skipped includes duplicates
 *                and files the AI relevance check discarded.
 */
export interface StatsRow {
  id: string;
  wave: number;
  kind: string;
  total_emails: number;
  unique_emails: number;
  duplicate_emails: number;
  ai_approved_count: number;
  ai_discarded_count: number;
  files_total: number;
  files_processed: number;
  files_skipped: number;
  files_duplicates: number;
  metadata_duration_ms: number;
  analyze_duration_ms: number;
  extract_duration_ms: number;
  ai_duration_ms: number;
  pdf_duration_ms: number;
  files_duration_ms: number;
  files_paused_ms: number;
}

export interface MailStats {
  sources: number;
  scanned: number;
  duplicates: number;
  unique: number;
  excluded: number;
  selected: number;
}

export interface FilesStats {
  found: number;
  delivered: number;
  skipped: number;
  duplicates: number;
  aiDiscarded: number;
}

export interface WaveStats {
  /** Request name, set when several requests are combined into a case total. */
  request?: string;
  wave: number;
  mail: MailStats;
  files: FilesStats;
  workMs: number;
}

export interface RequestStats {
  mail: MailStats;
  files: FilesStats;
  waves: WaveStats[];
}

const emptyMail = (): MailStats => ({
  sources: 0,
  scanned: 0,
  duplicates: 0,
  unique: 0,
  excluded: 0,
  selected: 0,
});

const emptyFiles = (): FilesStats => ({
  found: 0,
  delivered: 0,
  skipped: 0,
  duplicates: 0,
  aiDiscarded: 0,
});

function addMail(into: MailStats, from: MailStats) {
  into.sources += from.sources;
  into.scanned += from.scanned;
  into.duplicates += from.duplicates;
  into.unique += from.unique;
  into.excluded += from.excluded;
  into.selected += from.selected;
}

function addFiles(into: FilesStats, from: FilesStats) {
  into.found += from.found;
  into.delivered += from.delivered;
  into.skipped += from.skipped;
  into.duplicates += from.duplicates;
  into.aiDiscarded += from.aiDiscarded;
}

function rowWorkMs(row: StatsRow): number {
  return (
    row.metadata_duration_ms +
    row.analyze_duration_ms +
    row.extract_duration_ms +
    row.ai_duration_ms +
    row.pdf_duration_ms +
    Math.max(0, row.files_duration_ms - row.files_paused_ms)
  );
}

/** `aiDiscarded` maps a Files row id to the files its AI check discarded. */
export function buildRequestStats(
  rows: StatsRow[],
  aiDiscarded: ReadonlyMap<string, number> = new Map(),
): RequestStats {
  const byWave = new Map<number, WaveStats>();
  for (const row of rows) {
    const wave = byWave.get(row.wave) ?? {
      wave: row.wave,
      mail: emptyMail(),
      files: emptyFiles(),
      workMs: 0,
    };
    byWave.set(row.wave, wave);
    wave.workMs += rowWorkMs(row);
    if (row.kind === "pst") {
      addMail(wave.mail, {
        sources: 1,
        scanned: row.total_emails,
        duplicates: row.duplicate_emails,
        unique: row.unique_emails,
        excluded: row.ai_discarded_count,
        selected: row.ai_approved_count,
      });
    } else {
      addFiles(wave.files, {
        found: Math.max(
          row.files_total,
          row.files_processed + row.files_skipped,
        ),
        delivered: row.files_processed,
        skipped: row.files_skipped,
        duplicates: row.files_duplicates,
        aiDiscarded: aiDiscarded.get(row.id) ?? 0,
      });
    }
  }
  const waves = [...byWave.values()].sort((a, b) => a.wave - b.wave);
  const mail = emptyMail();
  const files = emptyFiles();
  for (const wave of waves) {
    addMail(mail, wave.mail);
    addFiles(files, wave.files);
  }
  return { mail, files, waves };
}

/** Combines requests into one case-level view; waves keep their request name. */
export function mergeRequestStats(
  parts: Array<{ name: string; stats: RequestStats | undefined }>,
): RequestStats {
  const mail = emptyMail();
  const files = emptyFiles();
  const waves: WaveStats[] = [];
  for (const { name, stats } of parts) {
    if (!stats) continue;
    addMail(mail, stats.mail);
    addFiles(files, stats.files);
    for (const wave of stats.waves) waves.push({ ...wave, request: name });
  }
  return { mail, files, waves };
}
