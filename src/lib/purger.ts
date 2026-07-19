import { prisma } from "./prisma";

/**
 * Compatibility purge utility used by /api/purge.
 *
 * Removes duplicate email rows for a file and refreshes dashboard counters.
 */
export async function purgePstDuplicates(fileId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.email.deleteMany({
      where: { file_id: fileId, is_duplicate: 1 },
    });

    const remaining = await tx.email.count({ where: { file_id: fileId } });

    const existing = await tx.processedFile.findUnique({
      where: { id: fileId },
      select: { status: true },
    });

    await tx.processedFile.update({
      where: { id: fileId },
      data: {
        duplicate_emails: 0,
        unique_emails: remaining,
        status: existing?.status === "failed" ? "failed" : "completed",
      },
    });
  });
}
