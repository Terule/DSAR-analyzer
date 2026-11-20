import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  createEmailRecord,
  decideEmail,
} from "../../../src/lib/email-decisions";
import {
  createDuplicateRecorder,
  exportAuditTrail,
  fileItemId,
  recordAttachmentItems,
  recordFileItems,
} from "../../../src/lib/items";
import { prisma } from "../../../src/lib/prisma";

const tag = crypto.randomUUID().slice(0, 8);
const fileId = `t-items-${tag}`;
const hash = (name: string) =>
  crypto.createHash("sha256").update(`${tag}-${name}`).digest("hex");

async function email(name: string, data: Record<string, unknown> = {}) {
  await prisma.email.create({
    data: {
      id: `t-items-e-${tag}-${name}`,
      file_id: fileId,
      email_hash: hash(name),
      is_duplicate: 0,
      ...data,
    },
  });
}

async function events(name: string) {
  return prisma.itemEvent.findMany({
    where: { item_id: hash(name) },
    orderBy: { created_at: "asc" },
  });
}

describe("items audit trail (shadow mode)", () => {
  before(async () => {
    await prisma.processedFile.create({
      data: { id: fileId, filepath: `/tmp/${fileId}.pst`, kind: "pst" },
    });
  });

  after(async () => {
    await prisma.item.deleteMany({ where: { file_id: fileId } });
    await prisma.email.deleteMany({ where: { file_id: fileId } });
    await prisma.processedFile.deleteMany({ where: { id: fileId } });
  });

  it("records a rule discard once, with its rule and reason", async () => {
    const reason =
      "Pre-filter: Subject or body contains privileged/confidential keyword";
    await createEmailRecord({
      data: {
        id: `t-items-e-${tag}-kw`,
        file_id: fileId,
        email_hash: hash("kw"),
        is_duplicate: 0,
      },
      decision: {
        decision: "discard",
        rule: "keyword",
        reason,
        decidedBy: "rule",
      },
    });
    await decideEmail({
      emailHash: hash("kw"),
      decision: "discard",
      rule: "keyword",
      reason,
      decidedBy: "rule",
    });
    const item = await prisma.item.findUnique({ where: { id: hash("kw") } });
    assert.equal(item?.state, "discarded");
    assert.equal(item?.decision_rule, "keyword");
    assert.equal(item?.decided_by, "rule");
    assert.equal(item?.file_id, fileId);
    assert.equal(
      (await events("kw")).length,
      1,
      "no event when nothing changed",
    );
  });

  it("follows an email from pending to an AI discard to a kept second review", async () => {
    await createEmailRecord({
      data: {
        id: `t-items-e-${tag}-ai`,
        file_id: fileId,
        email_hash: hash("ai"),
        is_duplicate: 0,
      },
    });
    await decideEmail({
      emailHash: hash("ai"),
      decision: "discard",
      rule: "ai_email",
      reason: "Task mention only",
      decidedBy: "haiku-4.5",
    });
    await decideEmail({
      emailHash: hash("ai"),
      decision: "keep",
      rule: "ai_email",
      reason: "About the subject",
      decidedBy: "haiku-5.5",
    });

    const trail = await events("ai");
    assert.deepEqual(
      trail.map((e) => [e.state, e.decision_rule, e.decided_by]),
      [
        ["pending", null, null],
        ["discarded", "ai_email", "haiku-4.5"],
        ["kept", "ai_email", "haiku-5.5"],
      ],
    );
    const item = await prisma.item.findUnique({ where: { id: hash("ai") } });
    assert.equal(item?.state, "kept");
  });

  it("marks attachments and keeps the parent link", async () => {
    await createEmailRecord({
      data: {
        id: `t-items-e-${tag}-parent`,
        file_id: fileId,
        email_hash: hash("parent"),
        is_duplicate: 0,
      },
    });
    await createEmailRecord({
      data: {
        id: `t-items-e-${tag}-child`,
        file_id: fileId,
        email_hash: hash("child"),
        is_duplicate: 0,
        is_attachment: 1,
        parent_email_hash: hash("parent"),
      },
    });
    const child = await prisma.item.findUnique({
      where: { id: hash("child") },
    });
    assert.equal(child?.origin, "attachment");
    assert.equal(child?.parent_id, hash("parent"));
  });

  it("records file decisions once and follows a change", async () => {
    const relPath = "Docs/a.docx";
    await recordFileItems(fileId, [
      {
        relPath,
        state: "discarded",
        rule: "keyword",
        reason: "Contains excluded keyword.",
        decidedBy: "rule",
      },
    ]);
    await recordFileItems(fileId, [
      {
        relPath,
        state: "discarded",
        rule: "keyword",
        reason: "Contains excluded keyword.",
        decidedBy: "rule",
      },
    ]);
    await recordFileItems(fileId, [
      {
        relPath,
        state: "kept",
        rule: "ai_file",
        reason: "About the subject",
        decidedBy: "haiku-5.5",
      },
    ]);
    const id = fileItemId(fileId, relPath);
    const trail = await prisma.itemEvent.findMany({
      where: { item_id: id },
      orderBy: { created_at: "asc" },
    });
    assert.deepEqual(
      trail.map((e) => [e.state, e.decision_rule]),
      [
        ["discarded", "keyword"],
        ["kept", "ai_file"],
      ],
    );
    assert.equal(
      (await prisma.item.findUnique({ where: { id } }))?.kind,
      "file",
    );
  });

  it("records dropped attachments under their email", async () => {
    await email("host");
    await recordAttachmentItems(fileId, hash("host"), [
      {
        filename: "deck.pptx",
        state: "discarded",
        rule: "unsupported_type",
        reason: "Unsupported attachment type .pptx.",
        decidedBy: "rule",
      },
    ]);
    const rows = await prisma.item.findMany({
      where: { parent_id: hash("host") },
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].origin, "attachment");
    assert.equal(rows[0].decision_rule, "unsupported_type");
    assert.equal(rows[0].case_request_id, null);
  });

  it("exports discarded and review items as a CSV with readable labels", async () => {
    const requestId = `t-items-req-${tag}`;
    const caseId = `t-items-case-${tag}`;
    await prisma.managedCase.create({
      data: {
        id: caseId,
        name: `ZZ-${tag}`,
        subject_name: "Maria Souza",
        subject_email: "maria.souza@corp.com",
        case_type: "employee",
      },
    });
    await prisma.caseRequest.create({
      data: {
        id: requestId,
        case_id: caseId,
        name: "R1",
        scope: "all",
        staging_path: "/tmp/s",
        deliverable_path: "/tmp/d",
      },
    });
    const owner = `t-items-owner-${tag}`;
    await prisma.processedFile.create({
      data: {
        id: owner,
        filepath: `/tmp/${owner}.pst`,
        kind: "files",
        case_request_id: requestId,
      },
    });
    await recordFileItems(owner, [
      {
        relPath: "Docs/a, b.docx",
        state: "discarded",
        rule: "keyword",
        reason: 'Contains "excluded" keyword.',
        decidedBy: "rule",
      },
      {
        relPath: "Docs/ok.docx",
        state: "review",
        rule: "ai_file",
        reason: "Needs a person",
        decidedBy: "haiku-4.5",
      },
    ]);
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "audit-csv-"));
    const file = await exportAuditTrail(requestId, out);
    assert.equal(file, path.join(out, "Discarded", "audit-trail.csv"));
    const lines = fs
      .readFileSync(file as string, "utf8")
      .trim()
      .split("\n");
    assert.equal(
      lines[0],
      "time,decision,item,kind,origin,parent,rule,reason,decided_by",
    );
    assert.equal(lines.length, 3);
    assert.ok(
      lines.some((l) =>
        l.endsWith(
          ',discarded,"Docs/a, b.docx",file,files_folder,,keyword,"Contains ""excluded"" keyword.",rule',
        ),
      ),
    );
    assert.ok(
      lines.some((l) =>
        l.endsWith(
          ",review,Docs/ok.docx,file,files_folder,,ai_file,Needs a person,haiku-4.5",
        ),
      ),
    );

    await prisma.item.deleteMany({ where: { case_request_id: requestId } });
    await prisma.processedFile.deleteMany({ where: { id: owner } });
    await prisma.caseRequest.deleteMany({ where: { id: requestId } });
    await prisma.managedCase.deleteMany({ where: { id: caseId } });
  });

  it("records email duplicates in bulk under the email they duplicate", async () => {
    await email("orig");
    const recorder = createDuplicateRecorder(fileId, null, 2);
    await recorder.add(hash("orig"));
    await recorder.add(hash("orig"));
    await recorder.add(hash("orig"));
    await recorder.flush();
    // The same run again (a reprocess) writes nothing new.
    const again = createDuplicateRecorder(fileId, null, 2);
    await again.add(hash("orig"));
    await again.add(hash("orig"));
    await again.add(hash("orig"));
    await again.flush();
    const rows = await prisma.item.findMany({
      where: { parent_id: hash("orig"), decision_rule: "dup" },
    });
    assert.equal(rows.length, 3);
    assert.equal(
      await prisma.itemEvent.count({
        where: { item_id: { in: rows.map((row) => row.id) } },
      }),
      3,
    );
    assert.equal(rows[0].state, "discarded");
  });

  it("a kept file and its later AI discard are one item with two events", async () => {
    const delivered = "Documents/Document abc.pdf";
    await recordFileItems(fileId, [
      {
        relPath: delivered,
        label: "Items/report.docx",
        state: "kept",
        rule: "files_filter",
        reason: "Passed the file filters.",
        decidedBy: "rule",
      },
    ]);
    await recordFileItems(fileId, [
      {
        relPath: delivered,
        state: "discarded",
        rule: "ai_file",
        reason: "Confidential",
        decidedBy: "haiku-4.5",
      },
    ]);
    const id = fileItemId(fileId, delivered);
    const item = await prisma.item.findUnique({ where: { id } });
    assert.equal(item?.label, "Items/report.docx", "the label survives");
    assert.equal(item?.state, "discarded");
    const trail = await prisma.itemEvent.findMany({
      where: { item_id: id },
      orderBy: { created_at: "asc" },
    });
    assert.deepEqual(
      trail.map((e) => e.state),
      ["kept", "discarded"],
    );
  });

  it("records the messages of a chat export as children, once", async () => {
    const relPath = "Messages/Message abc.pdf";
    const decision = {
      relPath,
      label: "Items/Chat_1.html",
      state: "kept" as const,
      rule: "files_filter",
      reason: "Passed the file filters.",
      decidedBy: "rule",
      children: [
        {
          key: "k1",
          label: "Message 2 of 12",
          state: "discarded" as const,
          rule: "keyword",
          reason: "Contains excluded keyword.",
        },
        {
          key: "k2",
          label: "Message 11 of 12",
          state: "kept" as const,
          rule: "chat_excerpt",
          reason: "Cites the subject; kept with the messages around it.",
        },
      ],
    };
    await recordFileItems(fileId, [decision]);
    await recordFileItems(fileId, [decision]);
    const parentId = fileItemId(fileId, relPath);
    const kids = await prisma.item.findMany({
      where: { parent_id: parentId },
      orderBy: { label: "asc" },
    });
    assert.deepEqual(
      kids.map((k) => [k.kind, k.label, k.state, k.decision_rule]),
      [
        ["chat_message", "Message 11 of 12", "kept", "chat_excerpt"],
        ["chat_message", "Message 2 of 12", "discarded", "keyword"],
      ],
    );
    assert.equal(
      await prisma.itemEvent.count({
        where: { item_id: { in: kids.map((k) => k.id) } },
      }),
      2,
      "idempotent: one event per child",
    );
  });

  it("records attachment decisions in bulk and updates only what changed", async () => {
    await email("bulk");
    const base = {
      state: "discarded" as const,
      rule: "signature_image",
      reason: "Signature or decoration image.",
      decidedBy: "rule",
    };
    const names = Array.from({ length: 5 }, (_, i) => `img-${i}.png`);
    await recordAttachmentItems(
      fileId,
      hash("bulk"),
      names.map((filename) => ({ filename, ...base })),
    );
    await recordAttachmentItems(
      fileId,
      hash("bulk"),
      names.map((filename, i) => ({
        filename,
        ...base,
        ...(i === 0
          ? {
              state: "review" as const,
              rule: "image_review",
              reason: "A person decides.",
            }
          : {}),
      })),
    );
    const rows = await prisma.item.findMany({
      where: { parent_id: hash("bulk") },
    });
    assert.equal(rows.length, 5);
    assert.equal(rows.filter((r) => r.state === "review").length, 1);
    const events = await prisma.itemEvent.count({
      where: { item_id: { in: rows.map((r) => r.id) } },
    });
    assert.equal(events, 6, "five creations and one change");
  });

  it("writes nothing for a hash that has no email", async () => {
    const written = await decideEmail({
      emailHash: "missing",
      decision: "keep",
      rule: "ai_email",
      reason: "x",
      decidedBy: "haiku-4.5",
    });
    assert.equal(written, 0);
    assert.equal(
      await prisma.item.findUnique({ where: { id: "missing" } }),
      null,
    );
  });
});
