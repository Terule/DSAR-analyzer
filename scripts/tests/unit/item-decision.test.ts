import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileDiscardRule } from "../../../src/lib/items";
import {
  type FileDecision,
  runStandaloneBatch,
} from "../../../src/lib/standalone-processor";

test("Files discard texts map to rules", () => {
  const cases: [string, string][] = [
    ["Discarded Duplicate EML a.eml (Content Match).", "dup"],
    ["Discarded a.docx: Password-protected/encrypted file.", "password"],
    ["Discarded .EML a.eml: Contains excluded keyword.", "keyword"],
    ["Discarded .EML a.eml: Data subject not mentioned.", "subject_absent"],
    ["Discarded a.pdf: produced a 0-byte/empty output.", "empty_output"],
  ];
  for (const [text, rule] of cases) assert.equal(fileDiscardRule(text), rule);
});

test("the Files engine reports each discard with its rule", async () => {
  const input = fs.mkdtempSync(path.join(os.tmpdir(), "item-in-"));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "item-out-"));
  const file = path.join(input, "mail.eml");
  fs.writeFileSync(
    file,
    [
      "From: Alice <alice@corp.com>",
      "To: Bob <bob@corp.com>",
      "Subject: Budget",
      "Date: Mon, 3 Mar 2025 10:06:00 +0000",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Quarterly numbers attached.",
      "",
    ].join("\r\n"),
  );
  const decisions: FileDecision[] = [];
  const original = console.log;
  console.log = () => {};
  try {
    await runStandaloneBatch({
      inputDir: input,
      filePaths: [file],
      messagesDir: path.join(out, "Messages"),
      documentsDir: path.join(out, "Documents"),
      subjectCriteria: { name: "Maria Souza", email: "maria.souza@corp.com" },
      onDecision: (d) => decisions.push(d),
    });
  } finally {
    console.log = original;
  }
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].filePath, file);
  assert.equal(decisions[0].rule, "subject_absent");
});

test("a .txt in Files follows the document keyword rule", async () => {
  const input = fs.mkdtempSync(path.join(os.tmpdir(), "item-txt-in-"));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "item-txt-out-"));
  const file = path.join(input, "note.txt");
  fs.writeFileSync(file, "Privileged advice for Maria Souza.");
  const decisions: FileDecision[] = [];
  const original = console.log;
  console.log = () => {};
  try {
    await runStandaloneBatch({
      inputDir: input,
      filePaths: [file],
      messagesDir: path.join(out, "Messages"),
      documentsDir: path.join(out, "Documents"),
      subjectCriteria: { name: "Maria Souza", email: "maria.souza@corp.com" },
      onDecision: (d) => decisions.push(d),
    });
  } finally {
    console.log = original;
  }
  assert.deepEqual(
    decisions.map((d) => d.rule),
    ["keyword"],
  );
});

test("a kept file is reported with where it was delivered", async () => {
  const input = fs.mkdtempSync(path.join(os.tmpdir(), "item-kept-in-"));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "item-kept-out-"));
  const file = path.join(input, "note.txt");
  fs.writeFileSync(file, "Lunch with Maria Souza tomorrow.");
  const decisions: FileDecision[] = [];
  const original = console.log;
  console.log = () => {};
  try {
    await runStandaloneBatch({
      inputDir: input,
      filePaths: [file],
      messagesDir: path.join(out, "Messages"),
      documentsDir: path.join(out, "Documents"),
      subjectCriteria: { name: "Maria Souza", email: "maria.souza@corp.com" },
      onDecision: (d) => decisions.push(d),
    });
  } finally {
    console.log = original;
  }
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].state, "kept");
  assert.match(
    decisions[0].deliveredRel ?? "",
    /^Documents\/Document [0-9a-f]+\.pdf$/,
  );
});

test("a keyword in the file name discards a document before it is read", async () => {
  const input = fs.mkdtempSync(path.join(os.tmpdir(), "item-name-in-"));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "item-name-out-"));
  const named = path.join(input, "Confidential - board minutes.txt");
  const plain = path.join(input, "Notes.txt");
  fs.writeFileSync(named, "Lunch with Maria Souza tomorrow.");
  fs.writeFileSync(plain, "Lunch with Maria Souza tomorrow, again.");
  const decisions: FileDecision[] = [];
  const original = console.log;
  console.log = () => {};
  try {
    await runStandaloneBatch({
      inputDir: input,
      filePaths: [named, plain],
      messagesDir: path.join(out, "Messages"),
      documentsDir: path.join(out, "Documents"),
      subjectCriteria: { name: "Maria Souza", email: "maria.souza@corp.com" },
      onDecision: (d) => decisions.push(d),
    });
  } finally {
    console.log = original;
  }
  const byName = Object.fromEntries(
    decisions.map((d) => [path.basename(d.filePath), d]),
  );
  assert.equal(byName["Confidential - board minutes.txt"].state, "discarded");
  assert.equal(byName["Confidential - board minutes.txt"].rule, "keyword");
  assert.match(byName["Confidential - board minutes.txt"].reason, /file name/);
  assert.equal(byName["Notes.txt"].state, "kept");
});
