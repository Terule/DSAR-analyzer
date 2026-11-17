import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildFilesAiBatchRequest,
  buildFilesAiSystemPrompt,
  buildFilesAiUserContent,
  decideFilesAi,
  NO_JUDGEMENT,
  parseFilesAiJudgement,
} from "../../../src/lib/files-ai-prompt";

const criteria = {
  name: "Jonathan Wheeler",
  email: "jw@corp.com",
  aliases: ["Jon W"],
};

const judged = (
  relevance: "relevant" | "irrelevant",
  sensitivity: string,
  reason = "r",
) => parseFilesAiJudgement(JSON.stringify({ relevance, sensitivity, reason }));

describe("parseFilesAiJudgement", () => {
  it("parses a clean answer and fenced JSON", () => {
    assert.deepEqual(judged("relevant", "none", "ok"), {
      relevance: "relevant",
      sensitivity: "none",
      reason: "ok",
    });
    assert.equal(
      parseFilesAiJudgement(
        '```json\n{"relevance":"irrelevant","sensitivity":"none","reason":"x"}\n```',
      ).relevance,
      "irrelevant",
    );
  });

  for (const bad of [
    "",
    "not json",
    "{}",
    '{"relevance":"maybe","sensitivity":"none"}',
    '{"relevance":"relevant","sensitivity":"salary"}',
    '{"decision":"keep","reason":"old shape"}',
    null,
    undefined,
    42,
  ]) {
    it(`has no judgement for ${JSON.stringify(bad)}`, () => {
      const out = parseFilesAiJudgement(bad);
      assert.equal(out.relevance, null);
      assert.equal(out.sensitivity, null);
    });
  }

  it("truncates an overlong reason to 240 chars", () => {
    assert.equal(
      judged("relevant", "none", "r".repeat(500)).reason.length,
      240,
    );
  });
});

describe("decideFilesAi", () => {
  const base = {
    mode: "employee",
    largeFile: false,
    subjectInvolved: false,
  } as const;

  it("sends an unusable answer to human review", () => {
    assert.equal(
      decideFilesAi({ ...base, judgement: NO_JUDGEMENT }).verdict,
      "review",
    );
  });

  it("discards confidential content in employee and client cases", () => {
    for (const mode of ["employee", "client"] as const) {
      const out = decideFilesAi({
        ...base,
        mode,
        judgement: judged("relevant", "payroll_compensation", "salary table"),
      });
      assert.equal(out.verdict, "discard");
      assert.match(out.reason, /payroll_compensation/);
    }
  });

  it("confidentiality wins even when the subject is plainly involved", () => {
    const out = decideFilesAi({
      ...base,
      subjectInvolved: true,
      judgement: judged("relevant", "payroll_compensation"),
    });
    assert.equal(out.verdict, "discard");
  });

  it("discards irrelevant files in employee cases only", () => {
    const irrelevant = judged("irrelevant", "none");
    assert.equal(
      decideFilesAi({ ...base, judgement: irrelevant }).verdict,
      "discard",
    );
    assert.equal(
      decideFilesAi({ ...base, mode: "client", judgement: irrelevant }).verdict,
      "keep",
    );
  });

  it("does not discard as irrelevant when the subject is plainly involved", () => {
    assert.equal(
      decideFilesAi({
        ...base,
        subjectInvolved: true,
        judgement: judged("irrelevant", "none"),
      }).verdict,
      "keep",
    );
  });

  it("sends a relevant, non-confidential large file to human review", () => {
    assert.equal(
      decideFilesAi({
        ...base,
        largeFile: true,
        judgement: judged("relevant", "none"),
      }).verdict,
      "review",
    );
  });

  it("still discards a large file that is confidential or irrelevant", () => {
    assert.equal(
      decideFilesAi({
        ...base,
        largeFile: true,
        judgement: judged("relevant", "legal_privileged"),
      }).verdict,
      "discard",
    );
    assert.equal(
      decideFilesAi({
        ...base,
        largeFile: true,
        judgement: judged("irrelevant", "none"),
      }).verdict,
      "discard",
    );
  });

  it("keeps a relevant, non-confidential, normal-sized file", () => {
    assert.equal(
      decideFilesAi({ ...base, judgement: judged("relevant", "none") }).verdict,
      "keep",
    );
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
      body: { temperature: number; model: string; reasoning_effort: string };
    };
    assert.equal(req.custom_id, "id1");
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.body.temperature, 0);
    // Luna reasons by default, which rejects temperature 0 and eats the output cap.
    assert.equal(req.body.model, "gpt-6-luna");
    assert.equal(req.body.reasoning_effort, "none");
  });

  it("states that only clearly unrelated files may be discarded", () => {
    assert.match(buildFilesAiSystemPrompt(criteria), /clearly/i);
  });

  it("asks about confidentiality in both modes, names the subject in both, and asks about relevance only for employees", () => {
    const employee = buildFilesAiSystemPrompt(criteria, "employee");
    const client = buildFilesAiSystemPrompt(criteria, "client");
    assert.match(employee, /payroll_compensation/);
    assert.match(client, /payroll_compensation/);
    assert.ok(employee.includes("Jonathan Wheeler"));
    // Client screening names the subject too: "the subject's own file" needs it.
    assert.ok(client.includes("Jonathan Wheeler"));
    assert.match(client, /always answer "relevant"/);
  });

  it("separates the subject's own data from other people's", () => {
    assert.match(buildFilesAiSystemPrompt(criteria), /own payslip/);
  });
});
