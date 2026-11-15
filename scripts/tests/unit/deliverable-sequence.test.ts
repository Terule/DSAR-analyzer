import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  isOneTrustDeliverablePath,
  renumberDeliverables,
} from "../../../src/lib/deliverable-sequence";

function make(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "seq-"));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  return root;
}

describe("isOneTrustDeliverablePath", () => {
  it("allows only files in Emails, Messages and Documents", () => {
    assert.equal(isOneTrustDeliverablePath("Emails/Email 01.pdf"), true);
    assert.equal(isOneTrustDeliverablePath("Documents/Document 1.pdf"), true);
    assert.equal(isOneTrustDeliverablePath("Messages/Message 1.pdf"), true);
  });

  it("never allows Discarded, For Human Review, Unconverted or hidden paths", () => {
    for (const p of [
      "Discarded/Documents/Document abc.pdf",
      "Discarded/verdicts.csv",
      "For Human Review/Emails/x.pdf",
      "For Human Review/review.csv",
      "Documents/Unconverted/a.xlsx",
      "Messages/Unconverted/a.eml",
      ".work/PST/x.eml",
      ".logs/run.log",
      "Emails/.hidden.pdf",
      "stray.pdf",
    ])
      assert.equal(isOneTrustDeliverablePath(p), false, p);
  });
});

describe("renumberDeliverables", () => {
  it("closes gaps in order and numbers manual additions last", () => {
    const root = make({
      "Emails/Email 10.pdf": "a",
      "Emails/Email 12.pdf": "b",
      "Emails/Email 83.pdf": "c",
      "Documents/Complaint.pdf": "x",
      "Documents/Annex.pdf": "y",
    });
    renumberDeliverables(root);
    assert.deepEqual(fs.readdirSync(path.join(root, "Emails")).sort(), [
      "Email 1.pdf",
      "Email 2.pdf",
      "Email 3.pdf",
    ]);
    assert.equal(
      fs.readFileSync(path.join(root, "Emails/Email 3.pdf"), "utf8"),
      "c",
    );
    assert.equal(
      fs.readFileSync(path.join(root, "Documents/Document 1.pdf"), "utf8"),
      "y",
    );
    assert.equal(
      fs.readFileSync(path.join(root, "Documents/Document 2.pdf"), "utf8"),
      "x",
    );
  });

  it("pads to the width of the count and leaves other folders alone", () => {
    const files: Record<string, string> = {
      "Discarded/Documents/Document zz.pdf": "d",
      "Documents/Unconverted/Document 7.xlsx": "u",
    };
    for (let i = 1; i <= 12; i++) files[`Emails/Email ${i * 2}.pdf`] = `${i}`;
    const root = make(files);
    renumberDeliverables(root);
    const emails = fs.readdirSync(path.join(root, "Emails")).sort();
    assert.equal(emails[0], "Email 01.pdf");
    assert.equal(emails[11], "Email 12.pdf");
    assert.ok(
      fs.existsSync(path.join(root, "Discarded/Documents/Document zz.pdf")),
    );
    assert.ok(
      fs.existsSync(path.join(root, "Documents/Unconverted/Document 7.xlsx")),
    );
  });

  it("does nothing when the sequence is already gapless", () => {
    const root = make({ "Emails/Email 1.pdf": "a", "Emails/Email 2.pdf": "b" });
    assert.equal(renumberDeliverables(root).renamed, 0);
  });
});
