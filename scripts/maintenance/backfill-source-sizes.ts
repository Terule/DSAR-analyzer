/**
 * Records each request's PST count and size from the rows its waves left
 * behind. Requests continued with a files-only wave had these overwritten with
 * zero once the sources were deleted from staging.
 *
 *   node --import tsx scripts/maintenance/backfill-source-sizes.ts [--apply]
 *
 * Without --apply it only prints what would change.
 */
import { prisma } from "../../src/lib/prisma";

async function main() {
  const apply = process.argv.includes("--apply");
  const requests = await prisma.caseRequest.findMany({
    select: {
      id: true,
      name: true,
      case: { select: { name: true } },
      pst_count: true,
      pst_size_bytes: true,
    },
  });
  for (const request of requests) {
    const rows = await prisma.processedFile.aggregate({
      where: { case_request_id: request.id, kind: "pst" },
      _count: { _all: true },
      _sum: { file_size_bytes: true },
    });
    const count = rows._count._all;
    const size = rows._sum.file_size_bytes ?? BigInt(0);
    if (count === 0) continue;
    if (count === request.pst_count && size === request.pst_size_bytes)
      continue;
    console.log(
      `${request.case.name}/${request.name}: ${request.pst_count} PST / ${request.pst_size_bytes} bytes -> ${count} PST / ${size} bytes`,
    );
    if (apply) {
      await prisma.caseRequest.update({
        where: { id: request.id },
        data: { pst_count: count, pst_size_bytes: size },
      });
    }
  }
  if (!apply) console.log("Dry run. Re-run with --apply to record these.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
