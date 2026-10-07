import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildFilesAiBatchRequest,
  buildFilesAiSystemPrompt,
  buildFilesAiUserContent,
  parseFilesAiVerdict,
} from "../../../src/lib/files-ai-prompt";

const criteria = {
  name: "Jonathan Wheeler",
  email: "jw@corp.com",
  aliases: ["Jon W"],
};

describe("parseFilesAiVerdict", () => {
  it("parses a clean discard", () => {
    assert.deepEqual(
      parseFilesAiVerdict('{"decision":"discard","reason":"Unrelated memo"}'),
      { verdict: "discard", reason: "Unrelated memo" },
    );
  });

  it("parses fenced JSON", () => {
    assert.equal(
      parseFilesAiVerdict('```json\n{"decision":"keep","reason":"x"}\n```')
        .verdict,
      "keep",
    );
  });

  for (const bad of [
    "",
    "not json",
    "{}",
    '{"decision":"maybe","reason":"x"}',
    '{"decision":"DISCARD "}',
    null,
    undefined,
    42,
  ]) {
    it(`keeps on malformed input ${JSON.stringify(bad)}`, () => {
      assert.equal(parseFilesAiVerdict(bad).verdict, "keep");
    });
  }

  it("truncates an overlong reason to 240 chars", () => {
    const out = parseFilesAiVerdict(
      JSON.stringify({ decision: "discard", reason: "r".repeat(500) }),
    );
    assert.equal(out.reason.length, 240);
  });
});

describe("batch request", () => {
  it("builds a deterministic chat-completions line", () => {
    const sys = buildFilesAiSystemPrompt(criteria);
    assert.ok(sys.includes("Jonathan Wheeler"));
    assert.ok(sys.includes("Jon W"));
    const user = buildFilesAiUserContent({
      fileName: "a.pdf",
      kind: "Document",
      sampled: true,
      text: "body",
    });
    assert.ok(user.includes("SAMPLE"));
    const req = buildFilesAiBatchRequest({
      customId: "id1",
      systemPrompt: sys,
      userContent: user,
    }) as {
      custom_id: string;
      method: string;
      url: string;
      body: { temperature: number };
    };
    assert.equal(req.custom_id, "id1");
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.body.temperature, 0);
  });

  it("states that only clearly unrelated files may be discarded", () => {
    assert.match(buildFilesAiSystemPrompt(criteria), /clearly/i);
  });
});
