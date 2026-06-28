import { db } from "./db";

/**
 * Compatibility purge utility used by /api/purge.
 *
 * Removes duplicate email rows for a file and refreshes dashboard counters.
 */
export async function purgePstDuplicates(fileId: string): Promise<void> {
  const txn = db.transaction((id: string) => {
    db.prepare("DELETE FROM emails WHERE file_id = ? AND is_duplicate = 1").run(
      id,
    );

    const remaining = db
      .prepare("SELECT COUNT(*) AS count FROM emails WHERE file_id = ?")
      .get(id) as { count: number };

    db.prepare(
      `
      UPDATE processed_files
      SET duplicate_emails = 0,
          unique_emails = ?,
          status = CASE WHEN status = 'failed' THEN status ELSE 'completed' END
      WHERE id = ?
      `,
    ).run(remaining.count || 0, id);
  });

  txn(fileId);
}
