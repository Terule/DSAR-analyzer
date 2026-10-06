import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  allWaveRowsFinished,
  countDeliveredEmails,
  deletePstFiles,
  deliveryComplete,
  isInsideDir,
  waveDeliveredOutput,
} from "../../../src/lib/source-prune-rules";

const done = {
  id: "a",
  filepath: "/s/PST/a.pst",
  status: "completed",
  ai_status: "completed",
  pdf_status: "completed",
};

describe("allWaveRowsFinished", () => {
  it("is true only when every row finished all three phases", () => {
    assert.equal(allWaveRowsFinished([done, { ...done, id: "b" }]), true);
  });
  it("is false when any row is failed, pending or still running", () => {
    assert.equal(
      allWaveRowsFinished([done, { ...done, pdf_status: "failed" }]),
      false,
    );
    assert.equal(
      allWaveRowsFinished([done, { ...done, ai_status: "pending" }]),
      false,
    );
    assert.equal(
      allWaveRowsFinished([done, { ...done, status: "extracting" }]),
      false,
    );
  });
  it("is false for an empty wave", () => {
    assert.equal(allWaveRowsFinished([]), false);
  });
});

describe("isInsideDir", () => {
  it("accepts files below the root and rejects the root, siblings and escapes", () => {
    assert.equal(isInsideDir("/data/S/C/R/PST", "/data/S/C/R/PST/a.pst"), true);
    assert.equal(
      isInsideDir("/data/S/C/R/PST", "/data/S/C/R/PST/sub/a.pst"),
      true,
    );
    assert.equal(isInsideDir("/data/S/C/R/PST", "/data/S/C/R/PST"), false);
    assert.equal(
      isInsideDir("/data/S/C/R/PST", "/data/S/C/R/Files/a.pst"),
      false,
    );
    assert.equal(
      isInsideDir("/data/S/C/R/PST", "/data/S/C/R/PST/../Files/a.pst"),
      false,
    );
    assert.equal(
      isInsideDir("/data/S/C/R/PST", "/data/S/C/R/PST2/a.pst"),
      false,
    );
  });
});

describe("waveDeliveredOutput", () => {
  function emailsDir(files: string[], warnings: string[] = []) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prune-out-"));
    for (const name of files) fs.writeFileSync(path.join(dir, name), "x");
    if (warnings.length) {
      fs.mkdirSync(path.join(dir, "Warning"));
      for (const name of warnings)
        fs.writeFileSync(path.join(dir, "Warning", name), "x");
    }
    return dir;
  }
  it("is true when an Email PDF numbered above the base exists", () => {
    const dir = emailsDir(["Email 0001.pdf", "Email 0004.pdf"]);
    try {
      assert.equal(waveDeliveredOutput(dir, { email: 3, warning: 0 }), true);
      assert.equal(waveDeliveredOutput(dir, { email: 0, warning: 0 }), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("is false when nothing is numbered above the base (earlier waves only)", () => {
    const dir = emailsDir(["Email 0001.pdf", "Email 0003.pdf"]);
    try {
      assert.equal(waveDeliveredOutput(dir, { email: 3, warning: 0 }), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("counts a Warning PDF above the warning base", () => {
    const dir = emailsDir([], ["Warning 01.pdf", "Warning 02.pdf"]);
    try {
      assert.equal(waveDeliveredOutput(dir, { email: 0, warning: 1 }), true);
      assert.equal(waveDeliveredOutput(dir, { email: 0, warning: 2 }), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("is false for an empty or missing folder", () => {
    assert.equal(
      waveDeliveredOutput("/definitely/not/here", { email: 0, warning: 0 }),
      false,
    );
  });
});

describe("deletePstFiles", () => {
  it("deletes only files inside the PST root, prunes emptied folders, keeps the root and unrelated files", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "prune-del-"));
    const pstRoot = path.join(base, "PST");
    try {
      fs.mkdirSync(path.join(pstRoot, "export", "deep"), { recursive: true });
      fs.mkdirSync(path.join(base, "Files"));
      const a = path.join(pstRoot, "a.pst");
      const b = path.join(pstRoot, "export", "deep", "b.pst");
      const keep = path.join(pstRoot, "notes.txt");
      const outside = path.join(base, "Files", "c.pst");
      for (const file of [a, b, keep, outside]) fs.writeFileSync(file, "x");
      const deleted = deletePstFiles(pstRoot, [a, b, outside]);
      assert.deepEqual(deleted.sort(), [a, b].sort());
      assert.equal(fs.existsSync(a), false);
      assert.equal(fs.existsSync(b), false);
      assert.equal(fs.existsSync(path.join(pstRoot, "export")), false);
      assert.equal(fs.existsSync(pstRoot), true);
      assert.equal(fs.existsSync(keep), true);
      assert.equal(fs.existsSync(outside), true);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
  it("keeps a folder that still holds other files", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "prune-del-"));
    const pstRoot = path.join(base, "PST");
    try {
      fs.mkdirSync(path.join(pstRoot, "export"), { recursive: true });
      const a = path.join(pstRoot, "export", "a.pst");
      const other = path.join(pstRoot, "export", "other.pst");
      fs.writeFileSync(a, "x");
      fs.writeFileSync(other, "x");
      deletePstFiles(pstRoot, [a]);
      assert.equal(fs.existsSync(other), true);
      assert.equal(fs.existsSync(path.join(pstRoot, "export")), true);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
  it("ignores files that are already gone", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "prune-del-"));
    try {
      fs.mkdirSync(path.join(base, "PST"));
      assert.deepEqual(
        deletePstFiles(path.join(base, "PST"), [
          path.join(base, "PST", "gone.pst"),
        ]),
        [],
      );
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("countDeliveredEmails", () => {
  function dir(files: string[]) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "prune-count-"));
    for (const f of files) fs.writeFileSync(path.join(d, f), "x");
    return d;
  }
  it("counts only Email PDFs numbered above the wave's base", () => {
    const d = dir([
      "Email 0001.pdf",
      "Email 0002.pdf",
      "Email 0003.pdf",
      "Email 0004.pdf",
    ]);
    try {
      assert.equal(countDeliveredEmails(d, 0), 4);
      assert.equal(countDeliveredEmails(d, 2), 2);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
  it("ignores attachments, zips and other files", () => {
    const d = dir([
      "Email 0001.pdf",
      "Email 0001 Attachment 1.pdf",
      "Email 0001 Attachment 2.zip",
      "notes.txt",
    ]);
    try {
      assert.equal(countDeliveredEmails(d, 0), 1);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
  it("is 0 for a missing folder", () => {
    assert.equal(countDeliveredEmails("/definitely/not/here", 0), 0);
  });
});

describe("deliveryComplete", () => {
  it("is true when every kept email has a PDF", () => {
    assert.equal(
      deliveryComplete({ kept: 10, delivered: 10, skippedByDesign: 0 }),
      true,
    );
  });
  it("counts emails skipped on purpose as accounted for", () => {
    assert.equal(
      deliveryComplete({ kept: 10, delivered: 8, skippedByDesign: 2 }),
      true,
    );
  });
  it("is false when any kept email is unaccounted for", () => {
    assert.equal(
      deliveryComplete({ kept: 3986, delivered: 3435, skippedByDesign: 16 }),
      false,
    );
    assert.equal(
      deliveryComplete({ kept: 10, delivered: 9, skippedByDesign: 0 }),
      false,
    );
  });
  it("is true for a wave that kept nothing", () => {
    assert.equal(
      deliveryComplete({ kept: 0, delivered: 0, skippedByDesign: 0 }),
      true,
    );
  });
});
