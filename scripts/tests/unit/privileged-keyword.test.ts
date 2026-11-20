import assert from "node:assert/strict";
import test, { describe, it } from "node:test";
import {
  hasPrivilegedKeyword,
  hasPrivilegedKeywordInDocument,
} from "../../../src/lib/exclusions";

describe("hasPrivilegedKeyword (one rule for every email)", () => {
  it("matches the keyword in the subject", () => {
    assert.equal(hasPrivilegedKeyword("Privileged advice", "Hello"), true);
  });

  it("matches the keyword in the body", () => {
    assert.equal(
      hasPrivilegedKeyword("Update", "This is strictly Confidential."),
      true,
    );
  });

  it("ignores the confidentiality disclaimer of the signature", () => {
    const body =
      "See you Friday.\n\nThis email and any attachments are confidential and intended only for the recipient.";
    assert.equal(hasPrivilegedKeyword("Friday", body), false);
    assert.equal(
      hasPrivilegedKeyword(
        "Friday",
        "See you Friday.\n\nConfidentiality notice: this message is private.",
      ),
      false,
    );
  });

  it("does not match inside other words", () => {
    assert.equal(hasPrivilegedKeyword("MICROSOFT update", "microscope"), false);
  });

  it("gives the same answer however the text is split between subject and body", () => {
    assert.equal(
      hasPrivilegedKeyword("", "Subject line\nCRO meeting"),
      hasPrivilegedKeyword("Subject line", "CRO meeting"),
    );
  });
});

test("documents: the confidentiality notice is ignored, the body is not", () => {
  const notice =
    "This email and any attachments are confidential and intended only for the recipient.";
  assert.equal(
    hasPrivilegedKeywordInDocument(`Meeting notes about Maria\n\n${notice}`),
    false,
  );
  assert.equal(
    hasPrivilegedKeywordInDocument(`Privileged legal advice\n\n${notice}`),
    true,
  );
  assert.equal(
    hasPrivilegedKeywordInDocument("CONFIDENTIAL - board paper"),
    true,
  );
});

test("documents: a sign-off in the middle does not hide the rest", () => {
  const text = "Intro\nThanks,\nBob\n\nLater section marked Confidential";
  assert.equal(hasPrivilegedKeywordInDocument(text), true);
  // The email rule would cut at "Thanks," and miss it: that is why documents differ.
  assert.equal(hasPrivilegedKeyword("", text), false);
});

test("a keyword in a file name counts, with separators as spaces", async () => {
  const { hasPrivilegedKeywordInFileName } = await import(
    "../../../src/lib/exclusions"
  );
  assert.equal(
    hasPrivilegedKeywordInFileName("Confidential - minutes.docx"),
    true,
  );
  assert.equal(hasPrivilegedKeywordInFileName("Privileged_advice.pdf"), true);
  assert.equal(hasPrivilegedKeywordInFileName("CRO report.xlsx"), true);
  assert.equal(hasPrivilegedKeywordInFileName("Microsoft roadmap.pdf"), false);
  assert.equal(hasPrivilegedKeywordInFileName("Quarterly review.docx"), false);
});
