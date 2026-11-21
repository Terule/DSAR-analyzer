/**
 * Fills an EMPTY database with made-up cases, requests, items and statistics so
 * the interface can be developed and compared with the design without touching
 * real data. Never run it against the real stack: it refuses unless the
 * database holds no cases yet, and it is meant for the isolated compose project
 * used for interface work (a second Postgres, nothing shared).
 *
 *   node --import tsx scripts/dev/seed-ui.ts
 */
import crypto from "node:crypto";
import { prisma } from "../../src/lib/prisma";

const id = () => crypto.randomUUID();
const minutes = (value: number) => value * 60_000;

async function pstRows(
  requestId: string,
  count: number,
  base: Partial<Record<string, number | string | bigint>>,
) {
  for (let index = 0; index < count; index++) {
    await prisma.processedFile.create({
      data: {
        id: id(),
        filename: `mailbox-${index + 1}.pst`,
        filepath: `/data/Staging/demo/${requestId}/PST/mailbox-${index + 1}.pst`,
        kind: "pst",
        case_request_id: requestId,
        file_size_bytes: BigInt(2_400_000_000 + index * 310_000_000),
        total_emails: 7_680,
        unique_emails: 5_861,
        duplicate_emails: 1_819,
        ...base,
      } as never,
    });
  }
}

const SUBJECTS: Array<[string, string, string | null, string | null]> = [
  [
    "Re: Leave request for next week",
    "kept",
    "ai_email",
    "She wrote it and is asking for leave.",
  ],
  [
    "Weekly sprint notes",
    "discarded",
    "ai_email",
    "Mentioned only as the owner of a task.",
  ],
  [
    "Concerns about workload",
    "discarded",
    "ai_email",
    "Discarded with low confidence (41% chance it should be kept).",
  ],
  [
    "Your appraisal outcome",
    "kept",
    "ai_email",
    "Kept after the 2nd analysis: appraisal about her.",
  ],
  [
    "Invoice 4471 payment run",
    "discarded",
    "keyword",
    "Subject or body contains a confidential keyword.",
  ],
  [
    "Lunch on Friday?",
    "discarded",
    "subject_absent",
    "Data subject not mentioned.",
  ],
  [
    "Team offsite photos",
    "discarded",
    "dup",
    "Duplicate of an email already in the case.",
  ],
  [
    "Update on the Henderson matter",
    "discarded",
    "keyword",
    "Subject or body contains a confidential keyword.",
  ],
  [
    "Holiday rota for August",
    "kept",
    "ai_email",
    "Schedules the subject and was sent to her.",
  ],
  [
    "Re: Salary review",
    "review",
    "ai_email",
    "Payroll data about the subject; a person should look.",
  ],
];

async function demoItems(requestId: string, total: number) {
  const rows = [];
  const events = [];
  for (let index = 0; index < total; index++) {
    const [subject, state, rule, reason] = SUBJECTS[index % SUBJECTS.length];
    const itemId = crypto
      .createHash("sha256")
      .update(`demo:${requestId}:${index}`)
      .digest("hex");
    rows.push({
      id: itemId,
      case_request_id: requestId,
      kind: "email",
      origin: "pst",
      label: index < SUBJECTS.length ? subject : `${subject} (${index})`,
      state,
      decision_rule: rule,
      reason,
      decided_by:
        rule === "ai_email"
          ? index % 7 === 3
            ? "haiku-5.5"
            : "haiku-4.5"
          : "rule",
    });
    events.push({
      id: id(),
      item_id: itemId,
      state,
      decision_rule: rule,
      reason,
      decided_by:
        rule === "ai_email"
          ? index % 7 === 3
            ? "haiku-5.5"
            : "haiku-4.5"
          : "rule",
      created_at: new Date(Date.now() - (total - index) * 4_000),
    });
  }
  await prisma.item.createMany({ data: rows });
  await prisma.itemEvent.createMany({ data: events });
}

/**
 * Duplicates and Files-folder items, in the proportions of a real request
 * (most of what comes in is repetition), so the outcome bars have both kinds.
 */
async function demoBulk(requestId: string) {
  const rows: Array<Record<string, unknown>> = [];
  const add = (
    kind: "email" | "file",
    origin: string,
    state: string,
    rule: string | null,
    decidedBy: string | null,
    total: number,
  ) => {
    for (let index = 0; index < total; index++) {
      rows.push({
        id: crypto
          .createHash("sha256")
          .update(
            `bulk:${requestId}:${kind}:${rule}:${state}:${decidedBy}:${index}`,
          )
          .digest("hex"),
        case_request_id: requestId,
        kind,
        origin,
        label: `${kind === "email" ? "Email" : "Document"} ${rule ?? state} ${index + 1}`,
        state,
        decision_rule: rule,
        decided_by: decidedBy,
      });
    }
  };
  add("email", "pst", "discarded", "dup", "rule", 640);
  add("file", "files_folder", "discarded", "dup", "rule", 7_000);
  add("file", "files_folder", "discarded", "subject_absent", "rule", 11_600);
  add("file", "files_folder", "discarded", "signature_image", "rule", 930);
  add("file", "files_folder", "discarded", "keyword", "rule", 870);
  add("file", "files_folder", "discarded", "unsupported_type", "rule", 710);
  add("file", "files_folder", "discarded", "ai_file", "haiku-4.5", 150);
  add("file", "files_folder", "discarded", "ai_file", "haiku-5.5", 380);
  add("file", "files_folder", "kept", "ai_file", "haiku-4.5", 970);
  add("file", "files_folder", "kept", "ai_file", "haiku-5.5", 245);
  add("file", "files_folder", "review", "ai_file", "haiku-4.5", 3);
  for (let start = 0; start < rows.length; start += 5_000) {
    await prisma.item.createMany({
      data: rows.slice(start, start + 5_000) as never,
    });
  }
}

async function main() {
  if ((await prisma.managedCase.count()) > 0) {
    throw new Error("Refusing to seed a database that already has cases.");
  }
  const now = Date.now();
  const make = async (
    name: string,
    type: "employee" | "client",
    subject: string,
    email: string,
  ) =>
    prisma.managedCase.create({
      data: {
        id: id(),
        name,
        case_type: type,
        subject_name: subject,
        subject_email: email,
      },
    });
  const request = async (
    caseId: string,
    caseName: string,
    name: string,
    status: string,
    extra: Record<string, unknown> = {},
  ) =>
    prisma.caseRequest.create({
      data: {
        id: id(),
        case_id: caseId,
        name,
        scope: "both",
        status,
        staging_path: `/data/Staging/${caseName}/${name}`,
        deliverable_path: `/data/Results/${caseName}/${name}`,
        pst_count: 5,
        total_emails: 38_410,
        started_at: new Date(now - minutes(42)),
        ...extra,
      },
    });

  const acm = await make(
    "ACM Corp",
    "employee",
    "Maria Souza",
    "maria.souza@acm.example",
  );
  const acmR1 = await request(acm.id, "ACM Corp", "R1", "running");
  await request(acm.id, "ACM Corp", "R2", "ready", { started_at: null });
  await pstRows(acmR1.id, 5, {
    status: "completed",
    ai_status: "batch_ready",
    ai_batches_total: 4,
    ai_batches_done: 2,
    ai_approved_count: 1_140,
    ai_discarded_count: 3_380,
    metadata_duration_ms: minutes(2),
    analyze_duration_ms: minutes(2),
    extract_duration_ms: minutes(7),
    ai_duration_ms: minutes(11),
  });
  await demoItems(acmR1.id, 220);
  await demoBulk(acmR1.id);

  const done = {
    status: "completed",
    ai_status: "completed",
    pdf_status: "completed",
    files_status: "completed",
    ai_batches_total: 3,
    ai_batches_done: 3,
    ai_approved_count: 900,
    ai_discarded_count: 4_100,
    pdf_total: 900,
    pdf_processed: 900,
    metadata_duration_ms: minutes(2),
    analyze_duration_ms: minutes(3),
    extract_duration_ms: minutes(9),
    ai_duration_ms: minutes(31),
    pdf_duration_ms: minutes(14),
  };
  for (const [name, type, subject, email, run, length] of [
    ["BRK Holdings", "client", "João Pereira", "joao@brk.example", "R1", 192],
    ["FRN Logística", "client", "Paula Rocha", "paula@frn.example", "R1", 57],
    ["DLT Sul", "employee", "Ana Lima", "ana@dlt.example", "R1", 108],
  ] as const) {
    const created = await make(name, type, subject, email);
    const completed = await request(created.id, name, run, "completed", {
      started_at: new Date(now - minutes(length + 60)),
      completed_at: new Date(now - minutes(60)),
      deliverable_files: 900,
    });
    await pstRows(completed.id, 1, done);
  }

  const glx = await make(
    "GLX Energia",
    "employee",
    "Rafael Nunes",
    "rafael@glx.example",
  );
  const failed = await request(glx.id, "GLX Energia", "R1", "running", {
    started_at: new Date(now - minutes(63)),
  });
  await pstRows(failed.id, 1, {
    ...done,
    status: "completed",
    pdf_status: "failed",
    files_status: "pending",
  });
  console.log("Seeded 5 demo cases.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
