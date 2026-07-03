import path from "node:path";
import { db } from "./db";

/**
 * The email pipeline shares working folders (.unique-emails/selected, Emails/…)
 * across every PST file in a case/request. These helpers let the AI-completion
 * and Render steps treat that group as one unit.
 *
 * A "case" here = all `kind='pst'` rows whose PST files live in the same
 * directory (e.g. `[case]/[request]/PST`).
 */

/** Ids of all PST rows in the same case/request directory as `fileId`. */
export function getCasePstFileIds(fileId: string): string[] {
  const row = db
    .prepare("SELECT filepath FROM processed_files WHERE id = ?")
    .get(fileId) as { filepath: string } | undefined;
  if (!row) return [fileId];

  const caseDir = path.dirname(row.filepath);
  const rows = db
    .prepare("SELECT id, filepath FROM processed_files WHERE kind = 'pst'")
    .all() as { id: string; filepath: string }[];

  const ids = rows
    .filter((r) => path.dirname(r.filepath) === caseDir)
    .map((r) => r.id);

  return ids.length > 0 ? ids : [fileId];
}

/**
 * True once every PST file in the case has finished its AI phase
 * (`completed` or `failed`) — i.e. the case's `selected/` set is final and
 * Render can run once for the whole case.
 */
export function isCaseAiSettled(fileId: string): boolean {
  const ids = getCasePstFileIds(fileId);
  const placeholders = ids.map(() => "?").join(",");
  const pending = db
    .prepare(
      `SELECT 1 FROM processed_files
       WHERE id IN (${placeholders})
         AND ai_status NOT IN ('completed', 'failed')
       LIMIT 1`,
    )
    .get(...ids);
  return !pending;
}

/**
 * The AI phase is case-level: one coordinator PST row holds the live batch
 * state, but the terminal status must be mirrored to every PST row in the case
 * so the UI aggregation and the render gate (`isCaseAiSettled`) see the case as
 * done. The real duration is recorded only on the coordinator (0 on siblings)
 * so the telemetry sum stays accurate.
 */
export function markCaseAiCompleted(
  coordinatorId: string,
  durationMs: number,
): void {
  const ids = getCasePstFileIds(coordinatorId);
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(
    `UPDATE processed_files
     SET ai_status = 'completed',
         batch_id = NULL,
         ai_started_at = NULL,
         ai_duration_ms = CASE WHEN id = ? THEN ? ELSE 0 END
     WHERE id IN (${placeholders})`,
  ).run(coordinatorId, durationMs, ...ids);
}

export function markCaseAiFailed(
  coordinatorId: string,
  durationMs: number,
): void {
  const ids = getCasePstFileIds(coordinatorId);
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(
    `UPDATE processed_files
     SET ai_status = 'failed',
         batch_id = NULL,
         ai_started_at = NULL,
         ai_duration_ms = CASE WHEN id = ? THEN ? ELSE 0 END
     WHERE id IN (${placeholders})`,
  ).run(coordinatorId, durationMs, ...ids);
}
