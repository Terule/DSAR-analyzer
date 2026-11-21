import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { lifecycleRowsDone } from "../../../src/lib/request-lifecycle";

const files = (files_status: string) => ({
  id: "f",
  kind: "files",
  pdf_status: "completed",
  files_status,
});
const pst = (pdf_status: string) => ({
  id: "p",
  kind: "pst",
  pdf_status,
  files_status: "pending",
});

describe("lifecycleRowsDone", () => {
  it("is done when every row completed", async () => {
    assert.equal(
      await lifecycleRowsDone(
        [pst("completed"), files("completed")],
        async () => false,
      ),
      true,
    );
  });

  it("is not done while a row is still working", async () => {
    assert.equal(
      await lifecycleRowsDone(
        [pst("completed"), files("processing")],
        async () => false,
      ),
      false,
    );
  });

  it("counts a failed row only when no job still works on it", async () => {
    assert.equal(
      await lifecycleRowsDone([files("failed")], async () => false),
      true,
    );
    assert.equal(
      await lifecycleRowsDone([files("failed")], async () => true),
      false,
    );
  });

  it("asks about the phase of the row's kind", async () => {
    const asked: string[] = [];
    await lifecycleRowsDone(
      [pst("failed"), files("failed")],
      async (_id, phase) => {
        asked.push(phase);
        return false;
      },
    );
    assert.deepEqual(asked, ["render", "files"]);
  });
});
