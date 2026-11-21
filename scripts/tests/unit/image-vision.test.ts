import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { ParsedRequest } from "../../../src/lib/bedrock/translate";
import {
  clearImageVisionCache,
  imageVisionTestOverride,
  judgeImageContent,
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

describe("image content judgement", () => {
  const criteria = {
    name: "Jonathan Wheeler",
    email: "jw@corp.com",
    aliases: [],
  };
  const judge = (mode: "employee" | "client" = "employee", enabled = true) =>
    judgeImageContent(PNG, { enabled, criteria, mode });

  beforeEach(() => {
    clearImageVisionCache();
    imageVisionTestOverride.converse = undefined;
  });

  it("keeps a relevant, harmless image and tells the model who the subject is", async () => {
    const calls = fake({
      relevance: "relevant",
      sensitivity: "none",
      confident: true,
      reason: "screenshot of a rota",
    });
    const result = await judge();
    assert.equal(result.verdict, "keep");
    assert.match(calls[0].system, /Jonathan Wheeler/);
    assert.match(calls[0].system, /Never identify a person from their face/);
    assert.ok(calls[0].image);
  });

  it("discards a confident confidential image, in every case type", async () => {
    fake({
      relevance: "relevant",
      sensitivity: "payroll_compensation",
      confident: true,
      reason: "a payslip",
    });
    assert.equal((await judge("employee")).verdict, "discard");
    clearImageVisionCache();
    assert.equal((await judge("client")).verdict, "discard");
  });

  it("discards an irrelevant image in employee cases only", async () => {
    fake({
      relevance: "irrelevant",
      sensitivity: "none",
      confident: true,
      has_readable_text: true,
      reason: "another person's invoice",
    });
    assert.equal((await judge("employee")).verdict, "discard");
    clearImageVisionCache();
    assert.equal((await judge("client")).verdict, "keep");
  });

  it("never discards a picture without readable text as unrelated", async () => {
    fake({
      relevance: "irrelevant",
      sensitivity: "none",
      confident: true,
      has_readable_text: false,
      reason: "a plain photo",
    });
    const result = await judge();
    assert.equal(result.verdict, "review");
    assert.match(result.reason, /No readable text/);
  });

  it("still discards confidential content without a readable-text flag", async () => {
    fake({
      relevance: "relevant",
      sensitivity: "legal_privileged",
      confident: true,
      has_readable_text: false,
      reason: "legal paper",
    });
    assert.equal((await judge()).verdict, "discard");
  });

  it("sends a discard it is not confident about to a person", async () => {
    fake({
      relevance: "irrelevant",
      sensitivity: "none",
      confident: false,
      reason: "maybe unrelated",
    });
    const result = await judge();
    assert.equal(result.verdict, "review");
    assert.match(result.reason, /Not sure enough to discard/);
  });

  it("sends doubt, failure, a switched-off screening and a bad answer to a person", async () => {
    fake(new Error("boom"));
    assert.equal((await judge()).verdict, "review");
    clearImageVisionCache();
    fake({ relevance: "maybe", sensitivity: "none", confident: true });
    assert.equal((await judge()).verdict, "review");
    clearImageVisionCache();
    const calls = fake({});
    assert.equal((await judge("employee", false)).verdict, "review");
    assert.equal(calls.length, 0);
  });

  it("judges the same image once per case", async () => {
    const calls = fake({
      relevance: "relevant",
      sensitivity: "none",
      confident: true,
      reason: "ok",
    });
    await judge();
    await judge();
    assert.equal(calls.length, 1);
  });
});
