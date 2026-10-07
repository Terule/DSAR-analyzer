import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { needsPolling } from "../../../src/lib/dashboard-polling";

const phase = (status: string) => ({ status });
const request = (status: string, phases: Record<string, string> = {}) => ({
  status,
  phaseProgress: Object.fromEntries(
    Object.entries(phases).map(([key, value]) => [key, phase(value)]),
  ),
});

describe("needsPolling", () => {
  it("polls while a request is queued or running", () => {
    assert.equal(needsPolling([{ requests: [request("running")] }]), true);
    assert.equal(needsPolling([{ requests: [request("queued")] }]), true);
  });

  it("keeps polling when a request reads 'completed' but a phase is still working (the stale Failed tile)", () => {
    assert.equal(
      needsPolling([
        { requests: [request("completed", { files: "processing" })] },
      ]),
      true,
    );
    assert.equal(
      needsPolling([
        { requests: [request("completed", { ai: "batch_ready" })] },
      ]),
      true,
    );
    assert.equal(
      needsPolling([
        { requests: [request("completed", { extract: "extracting" })] },
      ]),
      true,
    );
  });

  it("stops when everything is settled", () => {
    assert.equal(
      needsPolling([
        {
          requests: [
            request("completed", {
              parse: "completed",
              files: "failed",
              upload: "pending",
            }),
          ],
        },
      ]),
      false,
    );
    assert.equal(needsPolling([{ requests: [request("ready")] }]), false);
    assert.equal(needsPolling([]), false);
    assert.equal(needsPolling([{ requests: [] }]), false);
  });

  it("looks across every case and request", () => {
    assert.equal(
      needsPolling([
        { requests: [request("completed")] },
        { requests: [request("completed"), request("running")] },
      ]),
      true,
    );
  });

  it("copes with requests that carry no phase data", () => {
    assert.equal(
      needsPolling([{ requests: [{ status: "completed" }] }]),
      false,
    );
  });
});
