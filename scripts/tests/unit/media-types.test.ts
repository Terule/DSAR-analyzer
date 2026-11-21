import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { flattenAttachments } from "../../../src/lib/email-attachments";
import { fileDiscardRule } from "../../../src/lib/items";
import { isMediaExtension, mediaKind } from "../../../src/lib/media-types";

describe("video and audio", () => {
  it("are told apart by extension", () => {
    assert.equal(mediaKind(".MP4"), "video");
    assert.equal(mediaKind(".mp3"), "audio");
    assert.equal(mediaKind(".pdf"), null);
    assert.equal(isMediaExtension(".mov"), true);
    assert.equal(isMediaExtension(".docx"), false);
  });

  it("are dropped from an email with their own reason", async () => {
    const drops: Array<{ rule: string; reason: string }> = [];
    const kept = await flattenAttachments(
      [{ filename: "clip.mp4", content: Buffer.from("x") }],
      () => {},
      (drop) => drops.push(drop),
    );
    assert.equal(kept.length, 0);
    assert.equal(drops[0].rule, "unsupported_type");
    assert.match(drops[0].reason, /Video attachment/);
  });

  it("keep the unsupported_type rule in the Files folder", () => {
    assert.equal(
      fileDiscardRule(
        "Discarded .MP4 a.mp4: unsupported format (video is never delivered).",
      ),
      "unsupported_type",
    );
  });
});
