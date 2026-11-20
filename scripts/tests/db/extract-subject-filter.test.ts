import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { extractUniqueEmails } from "../../../src/lib/exporter";
import { prisma } from "../../../src/lib/prisma";
import { getPstArtifactPaths } from "../../../src/lib/pst-artifacts";

const tag = crypto.randomUUID().slice(0, 8);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "extract-subject-"));
const staging = path.join(root, "staging");
const extracted = path.join(root, "extracted");
const fileId = `t-xs-${tag}`;
const filepath = path.join(staging, `ZZ-${tag}`, "R1", "PST", `${fileId}.pst`);

function eml(subject: string, body: string, to = "bob@corp.com"): string {
  return [
    "From: Alice Jones <alice@corp.com>",
    `To: Bob <${to}>`,
    `Subject: ${subject}`,
    "Date: Mon, 3 Mar 2025 10:06:00 +0000",
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
    "",
  ].join("\r\n");
}

const mails = {
  cited: eml("Review", "Please book leave for Maria next week."),
  absent: eml("Budget", "Quarterly numbers attached."),
  lateMention: eml(
    "Notes",
    `${"filler line\n".repeat(3000)}\nThanks to Maria Souza.`,
  ),
  byAddress: eml("Hello", "No names here.", "maria.souza@corp.com"),
};

describe("Extract drops emails that never cite the subject", () => {
  const ids: Record<string, string> = {};
  const hashes: Record<string, string> = {};

  before(async () => {
    await prisma.processedFile.create({
      data: {
        id: fileId,
        filepath,
        kind: "pst",
        subject_name: "Maria Souza",
        subject_email: "maria.souza@corp.com",
        subject_aliases: "",
      },
    });
    const { rawEmlFolder } = getPstArtifactPaths({
      fileId,
      filepath,
      stagingPath: staging,
      extractedPath: extracted,
    });
    fs.mkdirSync(rawEmlFolder, { recursive: true });
    for (const [name, content] of Object.entries(mails)) {
      ids[name] = `t-xs-e-${tag}-${name}`;
      hashes[name] = crypto
        .createHash("sha256")
        .update(`${tag}-${name}`)
        .digest("hex");
      await prisma.email.create({
        data: {
          id: ids[name],
          file_id: fileId,
          email_hash: hashes[name],
          is_duplicate: 0,
        },
      });
      fs.writeFileSync(path.join(rawEmlFolder, `${ids[name]}.eml`), content);
    }
    process.env.STAGING_PATH = staging;
    await extractUniqueEmails(fileId, extracted);
  });

  after(async () => {
    await prisma.email.deleteMany({ where: { file_id: fileId } });
    await prisma.processedFile.deleteMany({ where: { id: fileId } });
    fs.rmSync(root, { recursive: true, force: true });
    await prisma.$disconnect();
  });

  const jsonExists = (name: string): boolean => {
    const { caseFolder } = getPstArtifactPaths({
      fileId,
      filepath,
      stagingPath: staging,
      extractedPath: extracted,
    });
    return fs.existsSync(
      path.join(
        caseFolder,
        ".unique-emails",
        "json-files",
        `${hashes[name]}.json`,
      ),
    );
  };
  const decision = async (name: string) =>
    prisma.email
      .findUniqueOrThrow({
        where: { id: ids[name] },
        select: { email_hash: true },
      })
      .then(async ({ email_hash }) => {
        const item = await prisma.item.findUnique({
          where: { id: email_hash },
        });
        return {
          ai_decision:
            ({ kept: "keep", discarded: "discard" } as Record<string, string>)[
              item?.state ?? ""
            ] ?? null,
          ai_reason: item?.reason ?? null,
        };
      });

  it("builds the payload for an email that cites the subject", async () => {
    assert.equal(jsonExists("cited"), true);
    assert.equal((await decision("cited")).ai_decision, null);
  });

  it("discards an email that never cites the subject, with no payload", async () => {
    assert.equal(jsonExists("absent"), false);
    const d = await decision("absent");
    assert.equal(d.ai_decision, "discard");
    assert.equal(d.ai_reason, "Pre-filter: Data subject not mentioned");
  });

  it("finds a mention far down a long body (the payload truncates, the rule does not)", async () => {
    assert.equal(jsonExists("lateMention"), true);
  });

  it("counts an address in the headers as a mention", async () => {
    assert.equal(jsonExists("byAddress"), true);
  });

  it("counts the discard in the case totals", async () => {
    const row = await prisma.processedFile.findUniqueOrThrow({
      where: { id: fileId },
      select: { ai_discarded_count: true },
    });
    assert.equal(row.ai_discarded_count, 1);
  });
});
