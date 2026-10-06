import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  keepTail,
  resolveJobLogs,
  workerLogPath,
} from "../../../src/lib/job-log";

describe("keepTail", () => {
  it("appends while under the limit and trims the oldest text beyond it", () => {
    assert.equal(keepTail("ab", "cd", 10), "abcd");
    assert.equal(keepTail("abcd", "efgh", 5), "defgh");
    assert.equal(keepTail("", "x".repeat(20), 4), "xxxx");
  });
});

describe("workerLogPath", () => {
  it("lives beside the dispatcher's own job log without colliding with it", () => {
    const worker = workerLogPath("/w", "job-1");
    assert.equal(worker, path.join("/w", "logs", "jobs", "job-1.worker.log"));
    assert.notEqual(worker, path.join("/w", "logs", "jobs", "job-1.log"));
  });
});

describe("resolveJobLogs", () => {
  function tempLog(content?: string) {
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "joblog-")),
      "job.worker.log",
    );
    if (content !== undefined) fs.writeFileSync(file, content);
    return file;
  }

  it("prefers the container's logs when they are available", async () => {
    const file = tempLog("from file");
    assert.equal(
      await resolveJobLogs(async () => "from container", file),
      "from container",
    );
  });
  it("falls back to the worker's own log once AutoRemove has deleted the container", async () => {
    const file = tempLog("readpst exploded");
    const logs = await resolveJobLogs(async () => {
      throw new Error("no such container");
    }, file);
    assert.equal(logs, "readpst exploded");
  });
  it("falls back when the container returned nothing", async () => {
    const file = tempLog("from file");
    assert.equal(await resolveJobLogs(async () => "  \n", file), "from file");
  });
  it("says so when neither source has anything", async () => {
    const missing = tempLog();
    assert.equal(
      await resolveJobLogs(async () => {
        throw new Error("gone");
      }, missing),
      "No worker logs available.",
    );
  });
});
