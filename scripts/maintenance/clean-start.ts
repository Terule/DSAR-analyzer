import { promises as fs } from "node:fs";
import { getControlPlanePool } from "../../src/lib/control-plane/postgres";
import { prisma } from "../../src/lib/prisma";

async function main() {
  // This intentionally targets only AIDA's fixed data mount. It never follows
  // configured paths outside /data.
  await Promise.all([
    fs.rm("/data/staging", { recursive: true, force: true }),
    fs.rm("/data/deliverables", { recursive: true, force: true }),
    fs.rm("/data/staging-area", { recursive: true, force: true }),
    fs.rm("/data/extracted-emails", { recursive: true, force: true }),
  ]);

  // Control-plane tables are infrastructure state and use pg by convention.
  const pool = getControlPlanePool();
  await pool.query(
    "TRUNCATE orchestrator_job_attempts, orchestrator_jobs, orchestrator_files_batch_results, orchestrator_workers RESTART IDENTITY CASCADE",
  );
  await prisma.$transaction([
    prisma.sharePointUploadArtifact.deleteMany(),
    prisma.email.deleteMany(),
    prisma.aiBatchRun.deleteMany(),
    prisma.processedFile.deleteMany(),
    prisma.runHistory.deleteMany(),
    prisma.caseHistory.deleteMany(),
    prisma.caseRequest.deleteMany(),
    prisma.managedCase.deleteMany(),
    prisma.pipelineSettings.deleteMany(),
  ]);
  await fs.mkdir("/data/staging", { recursive: true });
  await fs.mkdir("/data/deliverables", { recursive: true });
  console.log("AIDA clean start completed.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await getControlPlanePool().end();
  });
