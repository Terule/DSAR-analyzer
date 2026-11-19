import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { runStandaloneBatch } from "../../../src/lib/standalone-processor";

const NOTICE =
  "This email and any attachments are confidential and intended only for the recipient.";

function eml(options: {
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  body: string;
  base64?: boolean;
}): string {
  const body = options.base64
    ? Buffer.from(options.body, "utf-8").toString("base64")
    : options.body;
  return [
    `From: ${options.from ?? "Alice Jones <alice@corp.com>"}`,
    `To: ${options.to ?? "Bob Brown <bob@corp.com>"}`,
    ...(options.cc ? [`Cc: ${options.cc}`] : []),
    `Subject: ${options.subject ?? "Hello"}`,
    "Date: Mon, 3 Mar 2025 10:06:00 +0000",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    ...(options.base64 ? ["Content-Transfer-Encoding: base64"] : []),
    "",
    body,
    "",
  ].join("\r\n");
}

/** Runs the Files engine on one .eml and returns what the filter logged about it. */
async function filterLog(content: string): Promise<string> {
  const input = fs.mkdtempSync(path.join(os.tmpdir(), "mail-rules-in-"));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "mail-rules-out-"));
  const file = path.join(input, "mail.eml");
  fs.writeFileSync(file, content);
  const messages: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    messages.push(args.map(String).join(" "));
  };
  try {
    await runStandaloneBatch({
      inputDir: input,
      filePaths: [file],
      messagesDir: path.join(out, "Messages"),
      documentsDir: path.join(out, "Documents"),
      subjectCriteria: {
        name: "Maria Souza",
        email: "maria.souza@corp.com",
        personalEmail: "msouza@gmail.com",
      },
    });
  } finally {
    console.log = original;
  }
  return messages.join("\n");
}

describe("Files .eml follows the PST email rules", () => {
  it("keeps a message the subject wrote (it used to be discarded as 'authored by subject')", async () => {
    const log = await filterLog(
      eml({
        from: "Maria Souza <maria.souza@corp.com>",
        body: "Please book my leave for next week.",
      }),
    );
    assert.doesNotMatch(log, /Discarded \.EML/i);
  });

  it("discards a message that does not mention the subject", async () => {
    const log = await filterLog(eml({ body: "Quarterly numbers attached." }));
    assert.match(log, /Discarded \.EML .*Data subject not mentioned/);
  });

  it("finds the subject in an encoded body", async () => {
    const log = await filterLog(
      eml({ body: "Congratulations to Maria on the award.", base64: true }),
    );
    assert.doesNotMatch(log, /Discarded \.EML/i);
  });

  it("discards a keyword in the body", async () => {
    const log = await filterLog(
      eml({ body: "Maria, this is Privileged legal advice." }),
    );
    assert.match(log, /Discarded \.EML .*excluded keyword/);
  });

  it("ignores the confidentiality notice in the signature", async () => {
    const log = await filterLog(
      eml({
        body: `Maria, your review is attached.\n\nBest regards,\nAlice\n\n${NOTICE}`,
      }),
    );
    assert.doesNotMatch(log, /Discarded \.EML/i);
  });

  it("keeps a keyword mail sent to the subject's personal address", async () => {
    const log = await filterLog(
      eml({
        to: "Maria Souza <msouza@gmail.com>",
        body: "Confidential: your settlement terms.",
      }),
    );
    assert.doesNotMatch(log, /Discarded \.EML/i);
  });

  it("does not open the exception for the work address", async () => {
    const log = await filterLog(
      eml({
        to: "Maria Souza <maria.souza@corp.com>",
        body: "Confidential: board minutes.",
      }),
    );
    assert.match(log, /Discarded \.EML .*excluded keyword/);
  });
});
