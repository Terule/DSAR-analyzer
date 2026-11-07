import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isDeliverablePath } from "../../../src/lib/sharepoint-artifact-outbox";

describe("isDeliverablePath", () => {
  it("accepts the four delivered folders", () => {
    for (const p of [
      "Emails/Email 0001.pdf",
      "Emails/Warning/Warning 01.pdf",
      "Messages/Message 1.pdf",
      "Documents/Document 1.pdf",
      "For Human Review/review.csv",
      "For Human Review/Emails/Review 1.pdf",
    ]) {
      assert.equal(isDeliverablePath(p), true, p);
    }
  });

  it("never lets discarded, unconverted or internal files out", () => {
    for (const p of [
      "Discarded/Documents/Document 1.pdf",
      "Discarded/verdicts.csv",
      "Documents/Unconverted/abc-payroll.xlsx",
      "Messages/Unconverted/x.eml",
      ".work/PST/x.eml",
      "Emails",
      "notes.txt",
    ]) {
      assert.equal(isDeliverablePath(p), false, p);
    }
  });
});
