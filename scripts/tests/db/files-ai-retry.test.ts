import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  closeControlPlanePool,
  getControlPlanePool,
} from "../../../src/lib/control-plane/postgres";
import { ensureControlPlaneSchema } from "../../../src/lib/control-plane/schema";
import {
  applyFilesAiVerdicts,
  clearFilesAiState,
} from "../../../src/lib/files-ai-gate";
import { prisma } from "../../../src/lib/prisma";
import { closeQueueAdapter } from "../../../src/lib/queue/factory";

const tag = crypto.randomUUID().slice(0, 8);
const caseId = `t-far-case-${tag}`;
const requestId = `t-far-req-${tag}`;
const wave1 = `t-far-w1-${tag}`;
const wave2 = `t-far-w2-${tag}`;
const jobIds: string[] = [];

async function makeJob(fileId: string): Promise<string> {
  const id = crypto.randomUUID();
  jobIds.push(id);
  await getControlPlanePool().query(
    `INSERT INTO orchestrator_jobs (id, phase, status, dedupe_key, payload, attempts, max_attempts)
     VALUES ($1, 'files', 'running', $2, $3::jsonb, 1, 5)`,
    [
      id,
      `t-far-${id}`,
      JSON.stringify({ fileId, phase: "files", caseKey: "t" }),
    ],
  );
  return id;
}

async function discard(fileId: string, relPath: string, reason: string) {
  await prisma.filesAiVerdict.create({
    data: {
      id: `${fileId}:${relPath}`,
      file_id: fileId,
      rel_path: relPath,
      verdict: "discard",
      reason,
    },
  });
}

describe("Files AI across waves and retries", () => {
  before(async () => {
    await ensureControlPlaneSchema();
    await prisma.managedCase.create({
      data: {
        id: caseId,
        name: `ZZ-${caseId}`,
        subject_name: "T",
        subject_email: "t@example.com",
      },
    });
    await prisma.caseRequest.create({
      data: {
        id: requestId,
        case_id: caseId,
        name: "R1",
        scope: "files",
        status: "running",
        staging_path: `/tmp/${requestId}/s`,
        deliverable_path: `/tmp/${requestId}/d`,
      },
    });
    for (const [id, wave] of [
      [wave1, 1],
      [wave2, 2],
    ] as const) {
      await prisma.processedFile.create({
        data: {
          id,
          filename: "Files",
          kind: "files",
          wave,
          case_request_id: requestId,
        },
      });
    }
  });
  after(async () => {
    await getControlPlanePool().query(
      "DELETE FROM orchestrator_files_batch_results WHERE file_id = ANY($1)",
      [[wave1, wave2]],
    );
    await getControlPlanePool().query(
      "DELETE FROM orchestrator_jobs WHERE id = ANY($1::uuid[])",
      [jobIds],
    );
    await prisma.processedFile.deleteMany({
      where: { id: { in: [wave1, wave2] } },
    });
    await prisma.caseRequest.deleteMany({ where: { id: requestId } });
    await prisma.managedCase.deleteMany({ where: { id: caseId } });
    await prisma.$disconnect();
    await closeQueueAdapter();
    await closeControlPlanePool();
  });

  it("keeps earlier waves' rows in verdicts.csv when a later wave applies", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "far-"));
    for (const dir of ["Documents", "Discarded/Documents"]) {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
    }
    // Wave 1 already moved its discard in an earlier apply.
    fs.writeFileSync(
      path.join(
        root,
        "Discarded",
        "Documents",
        "Document 1111111111111111.pdf",
      ),
      "w1",
    );
    fs.writeFileSync(
      path.join(root, "Documents", "Document 2222222222222222.pdf"),
      "w2",
    );
    await discard(
      wave1,
      "Documents/Document 1111111111111111.pdf",
      "wave one reason",
    );
    await discard(
      wave2,
      "Documents/Document 2222222222222222.pdf",
      "wave two reason",
    );

    const result = await applyFilesAiVerdicts({
      jobId: await makeJob(wave2),
      fileId: wave2,
      requestOutputDir: root,
    });
    assert.equal(result.moved, 1);
    const csv = fs.readFileSync(
      path.join(root, "Discarded", "verdicts.csv"),
      "utf8",
    );
    assert.match(csv, /wave one reason/);
    assert.match(csv, /wave two reason/);
    // Wave 1's file is untouched.
    assert.equal(
      fs.existsSync(
        path.join(
          root,
          "Discarded",
          "Documents",
          "Document 1111111111111111.pdf",
        ),
      ),
      true,
    );
  });

  it("clearFilesAiState removes only this row's verdicts, runs and discarded files", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "far-"));
    fs.mkdirSync(path.join(root, "Discarded", "Documents"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(
        root,
        "Discarded",
        "Documents",
        "Document 3333333333333333.pdf",
      ),
      "x",
    );
    fs.writeFileSync(
      path.join(
        root,
        "Discarded",
        "Documents",
        "Document 4444444444444444.pdf",
      ),
      "y",
    );
    await discard(wave2, "Documents/Document 3333333333333333.pdf", "r");
    await prisma.filesAiBatchRun.create({
      data: { id: `run-${tag}`, file_id: wave2, status: "submitted" },
    });
    await prisma.filesAiVerdict.create({
      data: {
        id: `${wave1}:Documents/Document 4444444444444444.pdf`,
        file_id: wave1,
        rel_path: "Documents/Document 4444444444444444.pdf",
        verdict: "discard",
        reason: "other wave",
      },
    });

    await clearFilesAiState({ fileId: wave2, requestOutputDir: root });

    assert.equal(
      await prisma.filesAiVerdict.count({ where: { file_id: wave2 } }),
      0,
    );
    assert.equal(
      await prisma.filesAiBatchRun.count({ where: { file_id: wave2 } }),
      0,
    );
    assert.equal(
      fs.existsSync(
        path.join(
          root,
          "Discarded",
          "Documents",
          "Document 3333333333333333.pdf",
        ),
      ),
      false,
    );
    // The other wave's discarded file and verdict stay.
    assert.equal(
      fs.existsSync(
        path.join(
          root,
          "Discarded",
          "Documents",
          "Document 4444444444444444.pdf",
        ),
      ),
      true,
    );
    assert.ok(
      (await prisma.filesAiVerdict.count({ where: { file_id: wave1 } })) >= 1,
    );
  });
});
