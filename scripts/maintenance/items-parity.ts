/**
 * Read-only: for each request (or the one named), compares what the `emails`
 * rows decided with what the audit trail (`items`) recorded.
 *
 *   node --import tsx scripts/maintenance/items-parity.ts            # every request
 *   node --import tsx scripts/maintenance/items-parity.ts JPF R1     # one request
 */
import { checkEmailParity, problemsByStage } from "../../src/lib/items-parity";
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
    const parity = await checkEmailParity(request.id);
    if (parity.checked === 0) continue;
    console.log(
      `${request.case.name} ${request.name}: ${parity.checked} emails, ${parity.matching} match, ${parity.problems.length} differ, ${parity.ruleDiffers} with another rule`,
    );
    for (const group of problemsByStage(parity.problems).slice(0, 8)) {
      console.log(`    ${group.count} × ${group.kind}: ${group.stage}`);
    }
    if (parity.problems.length > 0) failed = true;
  }
  if (failed) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
