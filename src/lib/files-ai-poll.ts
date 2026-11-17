import {
  type FilesAiClient,
  failFilesAiRun,
  pollFilesAiBatches,
} from "./files-ai";
import { configuredFilesAiClient } from "./files-ai-provider";
import { prisma } from "./prisma";

/** Without an OpenAI client for this long, a submitted run is given up on (its files are kept). */
const STALE_RUN_MS = 30 * 60_000;

/**
 * Polls every submitted Files AI batch. A missing OpenAI key must not stall
 * delivery forever: runs older than STALE_RUN_MS are failed, which keeps their
 * files. Returns how many Files rows were polled or given up on.
 */
export async function pollFilesAiRuns(
  clientFactory: () => Promise<FilesAiClient> = configuredFilesAiClient,
  /** Limits the poll to these Files rows. Tests use it so they never touch real runs. */
  onlyFileIds?: string[],
): Promise<number> {
  const scope = onlyFileIds ? { file_id: { in: onlyFileIds } } : {};
  // A run whose submitter died between creating the run and submitting it has
  // no batch to wait for: give up on it so the Files AI step can settle.
  const stuck = await prisma.filesAiBatchRun.findMany({
    where: {
      ...scope,
      status: "claiming",
      created_at: { lt: new Date(Date.now() - STALE_RUN_MS) },
    },
    select: { id: true },
  });
  for (const run of stuck) {
    await failFilesAiRun(
      run.id,
      "Submission was interrupted before the batch was created.",
    );
  }

  const runs = await prisma.filesAiBatchRun.findMany({
    where: {
      ...scope,
      status: { in: ["submitted", "processing"] },
      openai_batch_id: { not: null },
    },
    select: { id: true, file_id: true, submitted_at: true, created_at: true },
  });
  if (runs.length === 0) return stuck.length;

  let client: FilesAiClient | null = null;
  try {
    client = await clientFactory();
  } catch (error) {
    console.error("[Files AI] No OpenAI client for polling:", error);
  }

  const fileIds = [...new Set(runs.map((run) => run.file_id))];
  if (client) {
    for (const fileId of fileIds) {
      try {
        await pollFilesAiBatches(fileId, client);
      } catch (error) {
        console.error(`[Files AI] Failed to poll ${fileId}:`, error);
      }
    }
    return fileIds.length;
  }

  const staleBefore = Date.now() - STALE_RUN_MS;
  for (const run of runs) {
    const startedAt = (run.submitted_at ?? run.created_at).getTime();
    if (startedAt < staleBefore) {
      await failFilesAiRun(run.id, "No OpenAI key to read the batch result.");
    }
  }
  return fileIds.length;
}

/** True while any Files AI batch is being prepared or is awaiting its result. */
export async function filesAiWorkRemains(): Promise<boolean> {
  const active = await prisma.filesAiBatchRun.findFirst({
    where: { status: { in: ["claiming", "submitted", "processing"] } },
    select: { id: true },
  });
  return !!active;
}
