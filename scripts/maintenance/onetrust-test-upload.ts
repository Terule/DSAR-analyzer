/**
 * Sends test files to an EXISTING OneTrust request, to check how OneTrust treats
 * them (redaction flag, email metadata, read-back). Nothing is created: the
 * request is looked up by the subject's name and email. Run inside the app
 * container, where the stored OneTrust credentials can be decrypted:
 *
 *   tsx scripts/maintenance/onetrust-test-upload.ts [--create] <first> <last> <email> <file>...
 *
 * With --create the request is created through the web form first (only when
 * none exists for that name and email).
 *
 * A file named `Email NN.pdf` is attached with a made-up subject and sent date,
 * the way an email PDF is delivered; any other file is attached without them.
 */
import fs from "node:fs";
import path from "node:path";
import {
  accessToken,
  alreadyAttachedFileIds,
  attachToResultSummary,
  findOrCreateTestRequest,
  resolvePublicRequestIdentity,
  uploadDocument,
} from "../../src/lib/onetrust";
import { getAiBatchSettings } from "../../src/lib/pipeline-settings";

async function main() {
  const args = process.argv.slice(2);
  const create = args[0] === "--create";
  const [first, last, email, ...files] = create ? args.slice(1) : args;
  if (!first || !last || !email || files.length === 0) {
    throw new Error("Usage: <first> <last> <email> <file>...");
  }
  const settings = await getAiBatchSettings();
  const token = await accessToken(settings);
  const identity = create
    ? await findOrCreateTestRequest(`${first} ${last}`, email)
    : await resolvePublicRequestIdentity(settings, token, first, last, email);
  if (create && identity && "created" in identity) {
    console.log(
      identity.created ? "Request created." : "Request already existed.",
    );
  }
  if (!identity) throw new Error("No OneTrust request found for that subject.");
  console.log("Request found:", identity.requestId);
  const before = await alreadyAttachedFileIds(
    settings,
    token,
    identity.requestId,
  );
  console.log("Files already attached:", before.size);
  for (const file of files) {
    const name = path.basename(file);
    try {
      const fileId = await uploadDocument(
        settings,
        token,
        identity.requestQueueId,
        file,
        name,
      );
      console.log(`Uploaded ${name} -> ${fileId}`);
      const isEmailPdf = /^Email \d+\.pdf$/.test(name);
      await attachToResultSummary(
        settings,
        token,
        identity.requestId,
        name,
        fileId,
        isEmailPdf
          ? {
              emlSubject: "Fake test email: Q3 budget review",
              sendDate: "2026-03-12T10:00:00.000Z",
            }
          : undefined,
      );
      console.log(`Attached ${name} (isRedact true)`);
    } catch (error) {
      console.log(
        `FAILED ${name}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  const after = await alreadyAttachedFileIds(
    settings,
    token,
    identity.requestId,
  );
  console.log(
    "Files attached now (may lag, OneTrust is asynchronous):",
    after.size,
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => fs.existsSync("/") && setTimeout(() => process.exit(), 100));
