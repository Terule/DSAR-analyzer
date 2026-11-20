/**
 * Read-only: for each request (or the one named), checks that the audit trail
 * (`items`) covers every email the pipeline read.
 *
 *   node --import tsx scripts/maintenance/items-parity.ts            # every request
 *   node --import tsx scripts/maintenance/items-parity.ts JPF R1     # one request
 */
import { checkEmailCoverage } from "../../src/lib/items-parity";
import { prisma } from "../../src/lib/prisma";

async function main() {
  const [caseName, requestName] = process.argv.slice(2);
  const requests = await prisma.caseRequest.findMany({
    where: {
      ...(requestName ? { name: requestName } : {}),
      ...(caseName ? { case: { name: caseName } } : {}),
    },
    select: { id: true, name: true, case: { select: { name: true } } },
    orderBy: { created_at: "asc" },
  });
  let failed = false;
  for (const request of requests) {
    const coverage = await checkEmailCoverage(request.id);
    if (coverage.emails === 0 && coverage.items === 0) continue;
    console.log(
      `${request.case.name} ${request.name}: ${coverage.emails} emails, ${coverage.items} items, ${coverage.missingCount} emails without an item, ${coverage.orphanItems} items without an email, ${coverage.pending} pending`,
    );
    if (coverage.missingCount > 0) {
      failed = true;
      console.log(`    e.g. ${coverage.missingItems.slice(0, 3).join(", ")}`);
    }
  }
  if (failed) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
