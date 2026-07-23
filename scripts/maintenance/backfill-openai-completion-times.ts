import OpenAI from "openai";
import { prisma } from "../../src/lib/prisma";

const coordinatorId = process.argv[2];
if (!coordinatorId) {
  throw new Error(
    "Usage: tsx scripts/maintenance/backfill-openai-completion-times.ts <coordinator-id>",
  );
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function run() {
  const runs = await prisma.aiBatchRun.findMany({
    where: { coordinator_id: coordinatorId, openai_batch_id: { not: null } },
    select: { id: true, openai_batch_id: true, submitted_at: true },
  });

  for (const run of runs) {
    if (!run.openai_batch_id) continue;
    const batch = await openai.batches.retrieve(run.openai_batch_id);
    if (typeof batch.completed_at !== "number") continue;
    await prisma.aiBatchRun.update({
      where: { id: run.id },
      data: { openai_completed_at: new Date(batch.completed_at * 1_000) },
    });
  }

  const timings = await prisma.aiBatchRun.aggregate({
    where: { coordinator_id: coordinatorId },
    _min: { submitted_at: true },
    _max: { openai_completed_at: true },
  });
  if (!timings._min.submitted_at || !timings._max.openai_completed_at) {
    throw new Error("No complete OpenAI timing range was available.");
  }

  const elapsedMs = Math.max(
    0,
    timings._max.openai_completed_at.getTime() -
      timings._min.submitted_at.getTime(),
  );
  await prisma.processedFile.update({
    where: { id: coordinatorId },
    data: { ai_duration_ms: elapsedMs },
  });

  console.log(
    `Updated ${runs.length} batch timestamps; AI elapsed ${Math.round(elapsedMs / 1_000)}s.`,
  );
}

run()
  .finally(() => prisma.$disconnect())
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
