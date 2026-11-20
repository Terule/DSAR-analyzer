import assert from "node:assert/strict";
import test from "node:test";
import {
  resultSummaryBody,
  resultSummaryPath,
} from "../../../src/lib/onetrust-attachments";

test("files are attached through the v3 endpoint", () => {
  assert.equal(
    resultSummaryPath("abc/123"),
    "/api/datasubject/v3/datadiscovery/requestqueues/abc%2F123",
  );
});

test("every attachment is marked for redaction", () => {
  assert.deepEqual(resultSummaryBody("AIDA", "a.pdf", "file-1"), {
    system: "AIDA",
    results: {},
    attachments: [{ fileName: "a.pdf", fileId: "file-1", isRedact: true }],
  });
});
