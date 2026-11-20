import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { ParsedRequest } from "../../../src/lib/bedrock/translate";
import {
  clearImageVisionCache,
  imageVisionTestOverride,
  judgeImageWithVision,
} from "../../../src/lib/image-vision";

// A 1x1 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function fake(answer: unknown) {
  const calls: ParsedRequest[] = [];
  imageVisionTestOverride.converse = async (request) => {
    calls.push(request);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return calls;
}

describe("image vision check", () => {
  beforeEach(() => {
    clearImageVisionCache();
    imageVisionTestOverride.converse = undefined;
  });

  it("removes a confident decoration and sends only the image", async () => {
    const calls = fake({
      category: "decoration",
      confident: true,
      reason: "company logo",
    });
    const result = await judgeImageWithVision(PNG, { enabled: true });
    assert.equal(result.verdict, "decoration");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].image?.format, "png");
    assert.ok(!/@|\.png|subject/i.test(calls[0].user + calls[0].customId));
  });

  it("leaves content, doubt and a missing answer to a person", async () => {
    fake({ category: "content", confident: true, reason: "a scanned letter" });
    assert.equal(
      (await judgeImageWithVision(PNG, { enabled: true })).verdict,
      "unsure",
    );
    clearImageVisionCache();
    fake({ category: "decoration", confident: false, reason: "maybe a logo" });
    assert.equal(
      (await judgeImageWithVision(PNG, { enabled: true })).verdict,
      "unsure",
    );
    clearImageVisionCache();
    fake(undefined);
    assert.equal(
      (await judgeImageWithVision(PNG, { enabled: true })).verdict,
      "unsure",
    );
  });

  it("keeps the image when the call fails", async () => {
    fake(new Error("boom"));
    const result = await judgeImageWithVision(PNG, { enabled: true });
    assert.equal(result.verdict, "unsure");
  });

  it("does not call the model when screening is off, the format is unknown or the file is too large", async () => {
    const calls = fake({
      category: "decoration",
      confident: true,
      reason: "x",
    });
    assert.equal(
      (await judgeImageWithVision(PNG, { enabled: false })).verdict,
      "unsure",
    );
    assert.equal(
      (
        await judgeImageWithVision(Buffer.from("not an image"), {
          enabled: true,
        })
      ).verdict,
      "unsure",
    );
    const big = Buffer.concat([PNG, Buffer.alloc(3_800_000)]);
    assert.equal(
      (await judgeImageWithVision(big, { enabled: true })).verdict,
      "unsure",
    );
    assert.equal(calls.length, 0);
  });

  it("asks once for the same picture", async () => {
    const calls = fake({
      category: "decoration",
      confident: true,
      reason: "logo",
    });
    await judgeImageWithVision(PNG, { enabled: true });
    await judgeImageWithVision(Buffer.from(PNG), { enabled: true });
    assert.equal(calls.length, 1);
  });
});
