/**
 * The one place an email decision is written (step 7 of docs/pipeline-refactor.md).
 * The decision on the `emails` row and the item with its history event are
 * written in the same transaction, so the audit trail can no longer miss a
 * decision and a failure to record it fails the write instead of passing
 * silently. Callers name the rule and who decided; nothing is parsed from the
 * reason text.
 */
import type { Prisma } from "@prisma/client";
import { cleanAuditLabel } from "./audit-csv";
import { prisma } from "./prisma";

export type EmailVerdict = "keep" | "discard" | "warning" | "review";

/** The item state each verdict means. */
const STATE = {
  keep: "kept",
  discard: "discarded",
  warning: "review",
  review: "review",
} as const;

export interface EmailDecisionInput {
  emailHash: string;
  decision: EmailVerdict;
  /** `keyword`, `draft`, `subject_absent`, `client_case`, `self_forward`, `ai_email`, `mail_screen`, … */
  rule: string;
  reason: string | null;
  /** `rule`, `haiku-4.5`, `haiku-5.5`, `bedrock`. */
  decidedBy: string;
  /** What a person recognises: the email subject. Kept once set. */
  label?: string;
  /** Other `emails` columns written with the decision (batch release, second review). */
  emailData?: Prisma.EmailUncheckedUpdateManyInput;
  /** Only an email that still matches is written, in both tables. */
  guard?: Prisma.EmailWhereInput;
}

type Op = Prisma.PrismaPromise<unknown>;

const READ_CHUNK = 1_000;

/**
 * The operations that record these decisions, for a caller that wants them in
 * its own `$transaction([...])` (the AI batch apply does). Reads happen now;
 * the writes are returned, not run.
 */
export async function planEmailDecisions(
  inputs: EmailDecisionInput[],
): Promise<{ ops: Op[]; matched: number }> {
  const ops: Op[] = [];
  let matchedCount = 0;
  const events: Prisma.ItemEventCreateManyInput[] = [];
  for (let start = 0; start < inputs.length; start += READ_CHUNK) {
    const chunk = inputs.slice(start, start + READ_CHUNK);
    const guardOf = new Map(chunk.map((input) => [input.emailHash, input]));
    // The guard differs per input, so rows are matched one guard group at a time.
    const matched = new Map<
      string,
      {
        file_id: string | null;
        parent_email_hash: string | null;
        is_attachment: number;
        processed_file: { case_request_id: string | null } | null;
      }
    >();
    const byGuard = new Map<string, EmailDecisionInput[]>();
    for (const input of chunk) {
      const key = JSON.stringify(input.guard ?? null);
      byGuard.set(key, [...(byGuard.get(key) ?? []), input]);
    }
    for (const group of byGuard.values()) {
      const rows = await prisma.email.findMany({
        where: {
          email_hash: { in: group.map((input) => input.emailHash) },
          ...(group[0].guard ?? {}),
        },
        select: {
          email_hash: true,
          file_id: true,
          parent_email_hash: true,
          is_attachment: true,
          processed_file: { select: { case_request_id: true } },
        },
      });
      for (const row of rows) matched.set(row.email_hash, row);
    }
    const existing = new Map(
      (
        await prisma.item.findMany({
          where: { id: { in: [...matched.keys()] } },
          select: {
            id: true,
            state: true,
            decision_rule: true,
            reason: true,
            decided_by: true,
          },
        })
      ).map((item) => [item.id, item]),
    );
    matchedCount += matched.size;
    for (const [hash, row] of matched) {
      const input = guardOf.get(hash);
      if (!input) continue;
      const state = STATE[input.decision];
      const reason = input.reason?.trim() ? input.reason : null;
      ops.push(
        prisma.email.updateMany({
          where: { email_hash: hash, ...(input.guard ?? {}) },
          data: {
            ai_decision: input.decision,
            ai_reason: input.reason,
            ...(input.emailData ?? {}),
          },
        }),
      );
      const label = cleanAuditLabel(input.label) || null;
      ops.push(
        prisma.item.upsert({
          where: { id: hash },
          create: {
            id: hash,
            case_request_id: row.processed_file?.case_request_id ?? null,
            file_id: row.file_id,
            parent_id: row.parent_email_hash,
            kind: "email",
            origin: row.is_attachment ? "attachment" : "pst",
            label,
            state,
            decision_rule: input.rule,
            reason,
            decided_by: input.decidedBy,
          },
          update: {
            ...(label ? { label } : {}),
            state,
            decision_rule: input.rule,
            reason,
            decided_by: input.decidedBy,
          },
        }),
      );
      const previous = existing.get(hash);
      const unchanged =
        previous &&
        previous.state === state &&
        previous.decision_rule === input.rule &&
        previous.reason === reason &&
        previous.decided_by === input.decidedBy;
      if (!unchanged) {
        events.push({
          item_id: hash,
          state,
          decision_rule: input.rule,
          reason,
          decided_by: input.decidedBy,
        });
      }
    }
  }
  if (events.length > 0)
    ops.push(prisma.itemEvent.createMany({ data: events }));
  return { ops, matched: matchedCount };
}

const WRITE_CHUNK = 500;

/** Writes the decisions and their audit trail, in transactions of a few hundred emails. */
export async function decideEmails(
  inputs: EmailDecisionInput[],
): Promise<number> {
  let written = 0;
  for (let start = 0; start < inputs.length; start += WRITE_CHUNK) {
    const { ops, matched } = await planEmailDecisions(
      inputs.slice(start, start + WRITE_CHUNK),
    );
    if (ops.length > 0) await prisma.$transaction(ops);
    written += matched;
  }
  return written;
}

/** Returns how many emails were written (0 when the guard no longer matched). */
export async function decideEmail(input: EmailDecisionInput): Promise<number> {
  return decideEmails([input]);
}

const requestOfFile = new Map<string, string | null>();

async function caseRequestOf(fileId: string): Promise<string | null> {
  if (requestOfFile.has(fileId)) return requestOfFile.get(fileId) ?? null;
  const row = await prisma.processedFile.findUnique({
    where: { id: fileId },
    select: { case_request_id: true },
  });
  requestOfFile.set(fileId, row?.case_request_id ?? null);
  return row?.case_request_id ?? null;
}

/**
 * Creates an email row together with its item: decided when a decision is
 * given, otherwise waiting (the AI phase decides it later).
 */
export async function createEmailRecord(options: {
  data: Prisma.EmailUncheckedCreateInput;
  label?: string;
  decision?: {
    decision: EmailVerdict;
    rule: string;
    reason: string | null;
    decidedBy: string;
  };
}): Promise<void> {
  const { data, decision } = options;
  const state = decision ? STATE[decision.decision] : "pending";
  const rule = decision?.rule ?? null;
  const reason = decision?.reason?.trim() ? decision.reason : null;
  const by = decision?.decidedBy ?? null;
  const label = cleanAuditLabel(options.label) || null;
  const caseRequestId = data.file_id ? await caseRequestOf(data.file_id) : null;
  await prisma.$transaction([
    prisma.email.create({
      data: {
        ...data,
        ...(decision
          ? { ai_decision: decision.decision, ai_reason: decision.reason }
          : {}),
      },
    }),
    prisma.item.upsert({
      where: { id: data.email_hash },
      create: {
        id: data.email_hash,
        case_request_id: caseRequestId,
        file_id: data.file_id ?? null,
        parent_id: data.parent_email_hash ?? null,
        kind: "email",
        origin: data.is_attachment ? "attachment" : "pst",
        label,
        state,
        decision_rule: rule,
        reason,
        decided_by: by,
      },
      update: {
        ...(label ? { label } : {}),
        state,
        decision_rule: rule,
        reason,
        decided_by: by,
      },
    }),
    prisma.itemEvent.create({
      data: {
        item_id: data.email_hash,
        state,
        decision_rule: rule,
        reason,
        decided_by: by,
      },
    }),
  ]);
}

/** Kept and discarded emails of these files, counted from the audit trail (duplicates excluded). */
export async function countEmailVerdicts(
  fileIds: string[],
): Promise<{ kept: number; discarded: number }> {
  const groups = await prisma.item.groupBy({
    by: ["state"],
    where: {
      file_id: { in: fileIds },
      kind: "email",
      state: { in: ["kept", "discarded"] },
      decision_rule: { not: "dup" },
    },
    _count: { _all: true },
  });
  const count = (state: string) =>
    groups.find((group) => group.state === state)?._count._all ?? 0;
  return { kept: count("kept"), discarded: count("discarded") };
}
