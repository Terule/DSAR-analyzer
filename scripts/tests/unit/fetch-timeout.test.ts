import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchWithTimeout } from "../../../src/lib/fetch-timeout";
import { uploadWorkerHung } from "../../../src/lib/sharepoint-watchdog";

// A fetch that never answers on its own but rejects when it is aborted,
// like a stalled network connection.
const stalledFetch = ((_input: unknown, init?: RequestInit) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () =>
      reject(init.signal?.reason ?? new Error("aborted")),
    );
  })) as unknown as typeof fetch;

describe("fetchWithTimeout", () => {
  it("returns the response when the server answers in time", async () => {
    const ok = (async () => new Response("hi")) as unknown as typeof fetch;
    const response = await fetchWithTimeout("https://x.test", {}, 1_000, ok);
    assert.equal(await response.text(), "hi");
  });
  it("turns a stalled request into a clear, retryable error", async () => {
    const started = Date.now();
    await assert.rejects(
      fetchWithTimeout("https://x.test/a", {}, 50, stalledFetch),
      /timed out after 50ms/,
    );
    assert.ok(Date.now() - started < 1_000);
  });
  it("still honours a caller's own abort signal", async () => {
    const controller = new AbortController();
    const pending = fetchWithTimeout(
      "https://x.test",
      { signal: controller.signal },
      5_000,
      stalledFetch,
    );
    controller.abort(new Error("cancelled by caller"));
    await assert.rejects(pending, /cancelled by caller/);
  });
  it("passes other request options through untouched", async () => {
    let seen: RequestInit | undefined;
    const spy = (async (_i: unknown, init?: RequestInit) => {
      seen = init;
      return new Response("ok");
    }) as unknown as typeof fetch;
    await fetchWithTimeout(
      "https://x.test",
      { method: "PUT", body: "b" },
      1_000,
      spy,
    );
    assert.equal(seen?.method, "PUT");
    assert.equal(seen?.body, "b");
    assert.ok(seen?.signal);
  });
});

describe("uploadWorkerHung", () => {
  const now = 10_000_000;
  const grace = 10 * 60_000;
  it("is hung when work waits but the worker's lease lapsed long ago", () => {
    assert.equal(
      uploadWorkerHung({
        pending: 5,
        leaseUntilMs: now - grace - 1,
        now,
        graceMs: grace,
      }),
      true,
    );
  });
  it("is not hung while the lease is current or only just expired", () => {
    assert.equal(
      uploadWorkerHung({
        pending: 5,
        leaseUntilMs: now + 1,
        now,
        graceMs: grace,
      }),
      false,
    );
    assert.equal(
      uploadWorkerHung({
        pending: 5,
        leaseUntilMs: now - 60_000,
        now,
        graceMs: grace,
      }),
      false,
    );
  });
  it("is not hung when there is nothing to upload or no lease was ever taken", () => {
    assert.equal(
      uploadWorkerHung({
        pending: 0,
        leaseUntilMs: now - grace * 5,
        now,
        graceMs: grace,
      }),
      false,
    );
    assert.equal(
      uploadWorkerHung({ pending: 5, leaseUntilMs: null, now, graceMs: grace }),
      false,
    );
  });
});
