import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  effectiveWaveScope,
  formatNumber,
  highestFinalizedNumber,
  highestNumber,
  isRenderedSourceRow,
  isUnfinalizedName,
  numberWidth,
  removeOutputAbove,
  rowsToPrune,
  unionScope,
  waveRowId,
} from "../../../src/lib/request-waves";

describe("unionScope", () => {
  it("widens mail + files to both", () => {
    assert.equal(unionScope("mail", "files"), "both");
    assert.equal(unionScope("files", "mail"), "both");
  });
  it("keeps a single kind and absorbs into both", () => {
    assert.equal(unionScope("mail", "mail"), "mail");
    assert.equal(unionScope("files", "files"), "files");
    assert.equal(unionScope("both", "mail"), "both");
    assert.equal(unionScope("mail", "both"), "both");
  });
  it("rejects unknown scopes", () => {
    assert.throws(() => unionScope("mail", "everything"));
  });
});

describe("waveRowId", () => {
  const request = "req-1";
  const file = "/data/Staging/MOW/R1/PST/Exchange.001.pst";
  it("keeps the legacy id for wave 1", () => {
    // sha256("req-1:/data/Staging/MOW/R1/PST/Exchange.001.pst").slice(0, 24)
    assert.equal(waveRowId(request, 1, file), "11df592541b148ef6e89e797");
  });
  it("gives the same path a different id in wave 2", () => {
    assert.notEqual(waveRowId(request, 1, file), waveRowId(request, 2, file));
    assert.notEqual(waveRowId(request, 2, file), waveRowId(request, 3, file));
  });
  it("is stable for the same inputs", () => {
    assert.equal(waveRowId(request, 2, file), waveRowId(request, 2, file));
  });
});

describe("highestNumber", () => {
  it("reads PDFs, attachments and unzipped folders", () => {
    const names = [
      "Email 0001.pdf",
      "Email 0012.pdf",
      "Email 0012 Attachment 1.pdf",
      "Email 0007 Attachment 1_unzipped",
      "Warning",
      ".logs",
    ];
    assert.equal(highestNumber(names, "Email"), 12);
  });
  it("returns 0 for an empty or unrelated folder", () => {
    assert.equal(highestNumber([], "Email"), 0);
    assert.equal(highestNumber(["Warning", "notes.txt"], "Email"), 0);
  });
  it("reads warning numbers separately", () => {
    assert.equal(
      highestNumber(["Warning 03.pdf", "Warning 11.pdf"], "Warning"),
      11,
    );
    assert.equal(highestNumber(["Warning 03.pdf"], "Email"), 0);
  });
});

describe("numberWidth / formatNumber", () => {
  it("uses the digits of the final number when nothing exists", () => {
    assert.equal(numberWidth([], "Email", 5), 1);
    assert.equal(numberWidth([], "Email", 120), 3);
  });
  it("never narrows below the width of existing files", () => {
    assert.equal(numberWidth(["Email 0099.pdf"], "Email", 100), 4);
  });
  it("grows past the boundary without renaming (9999 -> 10001)", () => {
    const width = numberWidth(["Email 9999.pdf"], "Email", 10001);
    assert.equal(width, 5);
    assert.equal(formatNumber(10000, width), "10000");
    assert.equal(formatNumber(9999, 4), "9999");
  });
  it("zero pads", () => {
    assert.equal(formatNumber(7, 4), "0007");
  });
});

describe("prune protection", () => {
  const base = {
    id: "a",
    filepath: "/gone.pst",
    case_request_id: "req",
    kind: "pst",
    pdf_status: "completed",
    files_status: "pending",
  };
  it("protects rendered rows of managed requests", () => {
    assert.equal(isRenderedSourceRow(base), true);
    assert.equal(
      isRenderedSourceRow({
        ...base,
        kind: "files",
        files_status: "completed",
        pdf_status: "pending",
      }),
      true,
    );
  });
  it("does not protect unfinished or legacy rows", () => {
    assert.equal(
      isRenderedSourceRow({ ...base, pdf_status: "processing" }),
      false,
    );
    assert.equal(
      isRenderedSourceRow({ ...base, case_request_id: null }),
      false,
    );
  });
  it("prunes missing unfinished rows but keeps missing rendered ones", () => {
    const rows = [
      base,
      { ...base, id: "b", pdf_status: "pending" },
      { ...base, id: "c", filepath: "/present.pst", pdf_status: "pending" },
      { ...base, id: "d", filepath: null, pdf_status: "pending" },
    ];
    const pruned = rowsToPrune(rows, (p) => p === "/present.pst").map(
      (r) => r.id,
    );
    assert.deepEqual(pruned, ["b", "d"]);
  });
});

describe("removeOutputAbove", () => {
  it("removes only entries numbered above the base", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "waves-"));
    try {
      for (const name of [
        "Email 0001.pdf",
        "Email 0002.pdf",
        "Email 0003.pdf",
        "Email 0003 Attachment 1.pdf",
      ]) {
        fs.writeFileSync(path.join(dir, name), "x");
      }
      fs.mkdirSync(path.join(dir, "Email 0004 Attachment 1_unzipped"));
      fs.mkdirSync(path.join(dir, "Warning"));
      const removed = removeOutputAbove(dir, "Email", 2);
      assert.equal(removed, 3);
      assert.deepEqual(fs.readdirSync(dir).sort(), [
        "Email 0001.pdf",
        "Email 0002.pdf",
        "Warning",
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("is a no-op for a missing folder", () => {
    assert.equal(removeOutputAbove("/definitely/not/here", "Email", 0), 0);
  });
});

describe("effectiveWaveScope", () => {
  it("wave 1 ignores wave_scope and uses scope", () => {
    assert.equal(effectiveWaveScope(1, "files", "mail"), "mail");
  });
  it("wave 2 with wave_scope uses wave_scope", () => {
    assert.equal(effectiveWaveScope(2, "files", "both"), "files");
  });
  it("wave 2 with null wave_scope falls back to scope", () => {
    assert.equal(effectiveWaveScope(2, null, "both"), "both");
  });
  it("throws on an invalid value", () => {
    assert.throws(() => effectiveWaveScope(2, "bogus", "both"));
    assert.throws(() => effectiveWaveScope(1, null, "bogus"));
  });
});

describe("Document / Message numbering", () => {
  it("reads Document and Message numbers separately", () => {
    const names = ["Document 3.pdf", "Document 12.docx", "Message 7.pdf"];
    assert.equal(highestNumber(names, "Document"), 12);
    assert.equal(highestNumber(names, "Message"), 7);
    assert.equal(numberWidth(names, "Document", 13), 2);
    assert.equal(numberWidth(["Message 0099.pdf"], "Message", 101), 4);
  });
});

describe("isUnfinalizedName", () => {
  it("is true for the 16-hex hash names Files workers write", () => {
    assert.equal(
      isUnfinalizedName("Document 0123456789abcdef.pdf", "Document"),
      true,
    );
    assert.equal(
      isUnfinalizedName("Message 0123456789abcdef.pdf", "Message"),
      true,
    );
    // An all-digit hash prefix is still a hash name.
    assert.equal(
      isUnfinalizedName("Document 1234567890123456.pdf", "Document"),
      true,
    );
    // Fallback copies keep the source extension, which may be empty.
    assert.equal(
      isUnfinalizedName("Document 0123456789abcdef.xlsx", "Document"),
      true,
    );
    assert.equal(
      isUnfinalizedName("Document 0123456789abcdef", "Document"),
      true,
    );
  });
  it("is false for finalized and unrelated names", () => {
    assert.equal(isUnfinalizedName("Document 12.pdf", "Document"), false);
    assert.equal(isUnfinalizedName("Document 0012.pdf", "Document"), false);
    assert.equal(
      isUnfinalizedName("Message 0123456789abcdef.pdf", "Document"),
      false,
    );
    assert.equal(
      isUnfinalizedName("Document 0123456789ABCDEF.pdf", "Document"),
      false,
    );
    assert.equal(
      isUnfinalizedName("Document 0123456789abcdef0.pdf", "Document"),
      false,
    );
    assert.equal(isUnfinalizedName("Unconverted", "Document"), false);
  });
});

describe("highestFinalizedNumber", () => {
  it("ignores hash-named files and subfolders", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "waves-"));
    try {
      for (const name of [
        "Document 1.pdf",
        "Document 7.docx",
        "Document 1234567890123456.pdf",
      ]) {
        fs.writeFileSync(path.join(dir, name), "x");
      }
      fs.mkdirSync(path.join(dir, "Unconverted"));
      assert.equal(highestFinalizedNumber(dir, "Document"), 7);
      assert.equal(highestFinalizedNumber(dir, "Message"), 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("returns 0 for a missing folder", () => {
    assert.equal(highestFinalizedNumber("/definitely/not/here", "Document"), 0);
  });
});
