import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hasPrivilegedKeyword } from "../../../src/lib/exclusions";

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
