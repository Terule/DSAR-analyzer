import { getCaseKey } from "./format";
import { prisma } from "./prisma";

/**
 * The email pipeline shares working folders (.unique-emails/selected, Emails/…)
 * across every PST file in a case/request. These helpers let the AI-completion
 * and Render steps treat that group as one unit.
 *
 * A "case" here = all `kind='pst'` rows in the same `[case]/[request]`.
 * Nested folders below the request are eDiscovery export containers only.
 */

/** Ids of all PST rows in the same case/request directory as `fileId`. */
export async function getCasePstFileIds(fileId: string): Promise<string[]> {
  const row = await prisma.processedFile.findUnique({
    where: { id: fileId },
    select: { filepath: true },
  });
  if (!row?.filepath) return [fileId];

  const caseKey = getCaseKey(row.filepath);
  const rows = await prisma.processedFile.findMany({
    where: { kind: "pst" },
    select: { id: true, filepath: true },
  });

  const ids = rows
    .filter((r) => r.filepath && getCaseKey(r.filepath) === caseKey)
    .map((r) => r.id);

  return ids.length > 0 ? ids : [fileId];
}

/**
 * True once every PST file in the case has finished its AI phase
 * (`completed` or `failed`) — i.e. the case's `selected/` set is final and
 * Render can run once for the whole case.
 */
export async function isCaseAiSettled(fileId: string): Promise<boolean> {
  const ids = await getCasePstFileIds(fileId);
  const pending = await prisma.processedFile.findFirst({
    where: {
      id: { in: ids },
      ai_status: { notIn: ["completed", "failed"] },
    },
    select: { id: true },
  });
  return !pending;
}

/**
 * The AI phase is case-level: one coordinator PST row holds the live batch
 * state, but the terminal status must be mirrored to every PST row in the case
 * so the UI aggregation and the render gate (`isCaseAiSettled`) see the case as
 * done. The real duration is recorded only on the coordinator (0 on siblings)
 * so the telemetry sum stays accurate. Both updates run inside a single
 * transaction so the case never ends up half-updated.
 */
export async function markCaseAiCompleted(
  coordinatorId: string,
  durationMs: number,
): Promise<void> {
  const ids = await getCasePstFileIds(coordinatorId);
  const siblingIds = ids.filter((id) => id !== coordinatorId);

  await prisma.$transaction([
    prisma.processedFile.update({
      where: { id: coordinatorId },
      data: {
        ai_status: "completed",
        batch_id: null,
        ai_started_at: null,
        ai_duration_ms: durationMs,
      },
    }),
    ...(siblingIds.length > 0
      ? [
          prisma.processedFile.updateMany({
            where: { id: { in: siblingIds } },
            data: {
              ai_status: "completed",
              batch_id: null,
              ai_started_at: null,
              ai_duration_ms: 0,
            },
          }),
        ]
      : []),
  ]);
}

export async function markCaseAiFailed(
  coordinatorId: string,
  durationMs: number,
): Promise<void> {
  const ids = await getCasePstFileIds(coordinatorId);
  const siblingIds = ids.filter((id) => id !== coordinatorId);

  await prisma.$transaction([
    prisma.processedFile.update({
      where: { id: coordinatorId },
      data: {
        ai_status: "failed",
        batch_id: null,
        ai_started_at: null,
        ai_duration_ms: durationMs,
      },
    }),
    ...(siblingIds.length > 0
      ? [
          prisma.processedFile.updateMany({
            where: { id: { in: siblingIds } },
            data: {
              ai_status: "failed",
              batch_id: null,
              ai_started_at: null,
              ai_duration_ms: 0,
            },
          }),
        ]
      : []),
  ]);
}
