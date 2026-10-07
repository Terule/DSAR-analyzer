# Files AI Relevance Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After Files conversion and before finalize, send each converted file (or a sample of a large one) to the OpenAI Batch API for a keep/discard relevance verdict; discarded files are moved to `Discarded/`, count as skipped, and are never numbered or uploaded.

**Architecture:** A new isolated module family (`files-ai-*`) with two new tables. A gate in the dispatcher's `settleFilesBatches` runs two new Files-phase control-plane jobs between the batches and the existing finalize job: `filesAiPrepare` (extract text from the delivered PDFs, build and submit batches) and `filesAiApply` (move discards, write the CSV, fix counters). The in-server poller in `batch-scheduler.ts` polls the new batch runs. The email AI path is not modified.

**Tech Stack:** Next.js 16 route handlers, Prisma 7 (Postgres), `openai` SDK Batch API (`gpt-4o-mini`), `js-tiktoken`, `pdf-parse` (already a dependency), node:test (`npm test`, `npm run test:db`), Biome.

**Spec:** `docs/superpowers/specs/2026-10-07-files-ai-relevance-design.md`

**Spec deviation (deliberate):** The spec has conversion write excerpt sidecars. The conversion engine (`standalone-processor.ts`, ~1,700 lines) has roughly ten output branches, so this plan instead reads the text back from the delivered PDFs inside `filesAiPrepare` with `pdf-parse` (already used in `converter.ts` and `standalone-processor.ts`). No conversion code changes. Update the spec's section 1 when this plan is approved.

## Global Constraints

- OpenAI **Batch API only** (no realtime/streaming), model `gpt-4o-mini`.
- Prisma-native queries only; never `$queryRaw`/`$executeRaw`. Control-plane files (`src/lib/control-plane/*`) may use `pg` SQL as they already do.
- Atomic claims use `updateMany({ where: {..., status: "pending"} })` and check `result.count`.
- No new cron/process: polling stays in `src/lib/batch-scheduler.ts`.
- Settings live in `PipelineSettings` and the System settings dialog, never `.env`.
- No hardcoded absolute paths; paths come from `STAGING_PATH` / `EXTRACTED_PATH` via `process.env`.
- Linter/formatter is Biome (`npx biome check --write <files>`). No ESLint/Prettier.
- Do not modify the email AI path (`ai.ts`, `batch-worker.ts` email functions) beyond importing shared helpers.
- Files are numbered only in `finalizeStandaloneDeliverables`; excluding files before finalize must leave no numbering gaps.
- Client cases (`case_type === "client"`) never run the AI step regardless of the setting.
- JW R1 is not re-judged; this applies to future Files runs only.
- Every error path **keeps** the file. Only an explicit parsed `"discard"` removes one.
- Discarded files count as **skipped** (processed decreases, skipped increases; handled total unchanged).

## Review Focus

1. **Malformed / missing AI output** (garbage JSON, empty content, a custom_id never returned): file must be kept. Pinned in Task 3 (`parseFilesAiVerdict`) and Task 5 (apply with missing results).
2. **Unreadable or image-only PDF (no extractable text):** must be kept without an AI call. Pinned in Task 4.
3. **Re-run / retry of the AI step** (prepare or apply run twice, worker killed mid-apply): no double moves, no double counting, no resubmitting items that already have verdicts. Pinned in Tasks 5 and 7.
4. **OpenAI key missing or batch submit failing:** the run proceeds to finalize with everything kept, never blocks delivery. Pinned in Task 5 and Task 7.
5. **Wave 2+ requests:** earlier waves' finalized `Document 0001.pdf` files must never be sent to the AI or moved; only this wave's unfinalized (hash-named) files. Pinned in Task 4.

---

### Task 1: `files_ai_enabled` setting

**Files:**
- Modify: `prisma/schema.prisma` (model `PipelineSettings`, next to `files_concurrency`)
- Create: `prisma/migrations/20261008100000_add_files_ai_enabled_setting/migration.sql`
- Modify: `src/lib/pipeline-settings.ts` (interface at ~line 46, normalize ~line 124-155, row mappers ~lines 193, 222, 242, 269)
- Modify: `src/app/api/settings/route.ts` (~line 42, 66)
- Modify: `src/lib/api.ts` (~line 105)
- Modify: `src/components/dashboard/SystemSettingsDialog.tsx` (System tab, near `deleteSourcePsts` / "Performance")
- Test: `scripts/tests/db/files-ai-setting.test.ts`

**Interfaces:**
- Produces: `AiBatchSettings.filesAiEnabled: boolean` (default `true`), DB column `files_ai_enabled`.

- [ ] **Step 1: Write the failing DB test**

```ts
// scripts/tests/db/files-ai-setting.test.ts
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  getAiBatchSettings,
  updateAiBatchSettings,
} from "../../../src/lib/pipeline-settings";
import { prisma } from "../../../src/lib/prisma";

describe("Files AI setting", () => {
  let original = true;
  before(async () => {
    original = (await getAiBatchSettings()).filesAiEnabled ?? true;
  });
  after(async () => {
    await prisma.pipelineSettings.updateMany({
      data: { files_ai_enabled: original },
    });
    await prisma.$disconnect();
  });

  it("defaults to on", async () => {
    await prisma.pipelineSettings.updateMany({
      data: { files_ai_enabled: true },
    });
    assert.equal((await getAiBatchSettings()).filesAiEnabled, true);
  });

  it("saves false and reads it back", async () => {
    const current = await getAiBatchSettings();
    const saved = await updateAiBatchSettings({
      ...current,
      filesAiEnabled: false,
    });
    assert.equal(saved.filesAiEnabled, false);
    const row = await prisma.pipelineSettings.findUniqueOrThrow({
      where: { id: "global" },
    });
    assert.equal(row.files_ai_enabled, false);
  });

  it("keeps the value when the caller omits it", async () => {
    const current = await getAiBatchSettings();
    await updateAiBatchSettings({ ...current, filesAiEnabled: false });
    const { filesAiEnabled: _omit, ...rest } = await getAiBatchSettings();
    const saved = await updateAiBatchSettings(rest);
    assert.equal(saved.filesAiEnabled, false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bash $SCRATCH/run-db-tests.sh scripts/tests/db/files-ai-setting.test.ts` (the throwaway-Postgres runner used for the other DB tests; `SCRATCH` = the session scratchpad dir). Expected: FAIL (`filesAiEnabled` undefined / column missing).

- [ ] **Step 3: Schema + migration**

In `prisma/schema.prisma`, after `files_concurrency Int @default(6)`:

```prisma
  files_ai_enabled            Boolean  @default(true)
```

`prisma/migrations/20261008100000_add_files_ai_enabled_setting/migration.sql`:

```sql
ALTER TABLE "pipeline_settings" ADD COLUMN "files_ai_enabled" BOOLEAN NOT NULL DEFAULT true;
```

(Confirm the table name with `grep -n '@@map' prisma/schema.prisma | grep -i settings`; use that name.)

- [ ] **Step 4: Wire `pipeline-settings.ts`**

Follow exactly how `deleteSourcePsts` is wired in the same file: add `filesAiEnabled?: boolean;` to the `AiBatchSettings` interface; in the normalizer set `const filesAiEnabled = input.filesAiEnabled ?? true;` and return it; in each row mapper add `filesAiEnabled: row.files_ai_enabled` (read) and `files_ai_enabled: settings.filesAiEnabled` (create and update payloads). Add `filesAiEnabled?: boolean` to `src/lib/api.ts` settings type and, in `src/app/api/settings/route.ts`, `filesAiEnabled: typeof body.filesAiEnabled === "boolean" ? body.filesAiEnabled : current.filesAiEnabled`.

- [ ] **Step 5: UI toggle**

In `SystemSettingsDialog.tsx`, copy the markup/handler used for the "Delete source PSTs" switch and add a second switch labelled "AI relevance check for files" with helper text "Files that the AI judges not relevant are not delivered or uploaded. They are kept in a Discarded folder." bound to `filesAiEnabled`.

- [ ] **Step 6: Run tests, lint, commit**

Run: `npx prisma generate && bash $SCRATCH/run-db-tests.sh scripts/tests/db/files-ai-setting.test.ts && npx tsc --noEmit -p . && npx biome check --write prisma src scripts`
Expected: PASS, no type errors.

```bash
git add -A && git commit -m "Add the AI relevance check for Files setting (default on)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Verdict and batch-run tables

**Files:**
- Modify: `prisma/schema.prisma` (new models; relation field on `ProcessedFile`)
- Create: `prisma/migrations/20261008110000_add_files_ai_tables/migration.sql`
- Test: `scripts/tests/db/files-ai-tables.test.ts`

**Interfaces:**
- Produces Prisma models `FilesAiBatchRun` (`files_ai_batch_runs`) and `FilesAiVerdict` (`files_ai_verdicts`) with the fields below. Later tasks rely on these exact names.

```prisma
model FilesAiBatchRun {
  id              String    @id
  file_id         String
  openai_batch_id String?   @unique
  status          String    @default("submitted") // submitted | processing | completed | failed
  request_count   Int       @default(0)
  estimated_tokens Int      @default(0)
  error           String?
  created_at      DateTime  @default(now())
  submitted_at    DateTime?
  completed_at    DateTime?

  file     ProcessedFile    @relation("FilesAiBatchRuns", fields: [file_id], references: [id], onDelete: Cascade, onUpdate: NoAction)
  verdicts FilesAiVerdict[]

  @@index([file_id, status])
  @@map("files_ai_batch_runs")
}

model FilesAiVerdict {
  id            String    @id // `${file_id}:${rel_path}`
  file_id       String
  rel_path      String    // "Documents/<name>" or "Messages/<name>", relative to the request output dir
  verdict       String?   // null while pending | "keep" | "discard"
  reason        String?
  sampled       Boolean   @default(false)
  batch_run_id  String?
  created_at    DateTime  @default(now())
  resolved_at   DateTime?

  file ProcessedFile      @relation("FilesAiVerdicts", fields: [file_id], references: [id], onDelete: Cascade, onUpdate: NoAction)
  run  FilesAiBatchRun?   @relation(fields: [batch_run_id], references: [id], onDelete: SetNull, onUpdate: NoAction)

  @@index([file_id, verdict])
  @@map("files_ai_verdicts")
}
```

Add to `model ProcessedFile`:

```prisma
  files_ai_batch_runs FilesAiBatchRun[] @relation("FilesAiBatchRuns")
  files_ai_verdicts   FilesAiVerdict[]  @relation("FilesAiVerdicts")
```

- [ ] **Step 1: Failing DB test** — create a Files-kind `ProcessedFile` (copy the fixture helper from `scripts/tests/db/revive-files-batches.test.ts`), insert one `FilesAiBatchRun` and two `FilesAiVerdict` rows (one `verdict: null`, one `"keep"`), assert `prisma.filesAiVerdict.count({ where: { file_id, verdict: null } }) === 1`, then delete the `ProcessedFile` and assert both tables are empty for it (cascade).
- [ ] **Step 2: Run** `bash $SCRATCH/run-db-tests.sh scripts/tests/db/files-ai-tables.test.ts` → FAIL (model missing).
- [ ] **Step 3: Add the models, write the migration** (`CREATE TABLE "files_ai_batch_runs" (...)`, `CREATE TABLE "files_ai_verdicts" (...)`, indexes, FKs with `ON DELETE CASCADE` / `SET NULL`). Generate it with `npx prisma migrate diff --from-schema-datamodel <old> --to-schema-datamodel prisma/schema.prisma --script` against the pre-change schema (`git show HEAD:prisma/schema.prisma > $SCRATCH/old.prisma`) and paste the result.
- [ ] **Step 4: Run** `npx prisma generate && bash $SCRATCH/run-db-tests.sh scripts/tests/db/files-ai-tables.test.ts` → PASS.
- [ ] **Step 5: Commit** `git add -A && git commit -m "Add Files AI verdict and batch run tables"` (with the co-author trailer).

---

### Task 3: Sample building, prompt and verdict parsing (pure code)

**Files:**
- Create: `src/lib/files-ai-text.ts`
- Create: `src/lib/files-ai-prompt.ts`
- Test: `scripts/tests/unit/files-ai-text.test.ts`, `scripts/tests/unit/files-ai-prompt.test.ts`

**Interfaces:**
- Produces from `files-ai-text.ts`:
  - `export interface SampleLimits { maxChars: number; headChars: number; maxMentionLines: number; maxLineChars: number }`
  - `export const SAMPLE_LIMITS: SampleLimits` (`maxChars: 6000, headChars: 3000, maxMentionLines: 25, maxLineChars: 300`)
  - `export const LARGE_TEXT_CHARS = 60_000` (a document whose extracted text is longer than this is "large" and sampled; shorter texts are sent whole, truncated at `SAMPLE_LIMITS.maxChars`)
  - `export function buildSample(text: string, mentionTokens: string[], limits?: SampleLimits): { text: string; sampled: boolean }`
  - `export function subjectMentionTokens(criteria: FilesAiCriteria): string[]`
- Produces from `files-ai-prompt.ts`:
  - `export interface FilesAiCriteria { name: string; email: string; personalEmail?: string; aliases: string[] }`
  - `export const FILES_AI_MODEL = "gpt-4o-mini"`
  - `export const FILES_AI_RESPONSE_FORMAT` (json_schema `dsar_files_decision`: `{ decision: "keep"|"discard", reason: string<=240 }`, strict)
  - `export function buildFilesAiSystemPrompt(criteria: FilesAiCriteria): string`
  - `export function buildFilesAiUserContent(input: { fileName: string; kind: "Document" | "Message"; sampled: boolean; text: string }): string`
  - `export function buildFilesAiBatchRequest(input: { customId: string; systemPrompt: string; userContent: string }): object` (a `/v1/chat/completions` batch line, `temperature: 0`, `max_completion_tokens: 120`)
  - `export function parseFilesAiVerdict(raw: unknown): { verdict: "keep" | "discard"; reason: string }` — **any** malformed input returns `{ verdict: "keep", reason: "Unparseable AI output; kept." }`.

- [ ] **Step 1: Failing tests**

```ts
// scripts/tests/unit/files-ai-text.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildSample,
  LARGE_TEXT_CHARS,
  SAMPLE_LIMITS,
  subjectMentionTokens,
} from "../../../src/lib/files-ai-text";

describe("buildSample", () => {
  it("sends short text whole and not sampled", () => {
    const out = buildSample("Hello Jonathan Wheeler", ["jonathan wheeler"]);
    assert.equal(out.sampled, false);
    assert.equal(out.text, "Hello Jonathan Wheeler");
  });

  it("truncates medium text at maxChars without marking it sampled", () => {
    const text = "a".repeat(SAMPLE_LIMITS.maxChars + 500);
    const out = buildSample(text, ["x"]);
    assert.equal(out.sampled, false);
    assert.equal(out.text.length, SAMPLE_LIMITS.maxChars);
  });

  it("samples large text: head plus the lines that mention the subject", () => {
    const filler = "lorem ipsum dolor sit amet\n".repeat(
      Math.ceil(LARGE_TEXT_CHARS / 27) + 10,
    );
    const text = `${filler}row 999 | Jonathan Wheeler | approved\n${filler}`;
    const out = buildSample(text, ["jonathan wheeler"]);
    assert.equal(out.sampled, true);
    assert.ok(out.text.includes("Jonathan Wheeler"));
    assert.ok(out.text.length <= SAMPLE_LIMITS.maxChars + 200);
  });

  it("caps mention lines and long lines", () => {
    const lines = Array.from(
      { length: 200 },
      (_, i) => `line ${i} jonathan wheeler ${"y".repeat(1000)}`,
    ).join("\n");
    const text = `${"z".repeat(LARGE_TEXT_CHARS)}\n${lines}`;
    const out = buildSample(text, ["jonathan wheeler"]);
    const mentionLines = out.text
      .split("\n")
      .filter((l) => l.includes("jonathan wheeler"));
    assert.ok(mentionLines.length <= SAMPLE_LIMITS.maxMentionLines);
    assert.ok(
      mentionLines.every((l) => l.length <= SAMPLE_LIMITS.maxLineChars),
    );
  });

  it("handles empty text", () => {
    assert.deepEqual(buildSample("", ["x"]), { text: "", sampled: false });
  });
});

describe("subjectMentionTokens", () => {
  it("lowercases and de-duplicates name, aliases and emails", () => {
    const tokens = subjectMentionTokens({
      name: "Jonathan Wheeler",
      email: "jw@corp.com",
      personalEmail: "JW@home.com",
      aliases: ["Jon W", "jon w", ""],
    });
    assert.deepEqual(tokens.sort(), [
      "jon w",
      "jonathan wheeler",
      "jw@corp.com",
      "jw@home.com",
    ]);
  });
});
```

```ts
// scripts/tests/unit/files-ai-prompt.test.ts
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
    }) as { custom_id: string; method: string; url: string; body: { temperature: number } };
    assert.equal(req.custom_id, "id1");
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.body.temperature, 0);
  });

  it("states that only clearly unrelated files may be discarded", () => {
    assert.match(buildFilesAiSystemPrompt(criteria), /clearly/i);
  });
});
```

- [ ] **Step 2: Run** `node --import tsx --test scripts/tests/unit/files-ai-text.test.ts scripts/tests/unit/files-ai-prompt.test.ts` → FAIL (modules missing).

- [ ] **Step 3: Implement `files-ai-text.ts`**

```ts
import type { FilesAiCriteria } from "./files-ai-prompt";

export interface SampleLimits {
  maxChars: number;
  headChars: number;
  maxMentionLines: number;
  maxLineChars: number;
}

export const SAMPLE_LIMITS: SampleLimits = {
  maxChars: 6000,
  headChars: 3000,
  maxMentionLines: 25,
  maxLineChars: 300,
};

/** Extracted text longer than this is sampled instead of sent (truncated) whole. */
export const LARGE_TEXT_CHARS = 60_000;

export function subjectMentionTokens(criteria: FilesAiCriteria): string[] {
  const tokens = new Set<string>();
  for (const value of [
    criteria.name,
    criteria.email,
    criteria.personalEmail ?? "",
    ...criteria.aliases,
  ]) {
    const token = value.trim().toLowerCase();
    if (token) tokens.add(token);
  }
  return [...tokens];
}

export function buildSample(
  text: string,
  mentionTokens: string[],
  limits: SampleLimits = SAMPLE_LIMITS,
): { text: string; sampled: boolean } {
  if (text.length <= LARGE_TEXT_CHARS) {
    return { text: text.slice(0, limits.maxChars), sampled: false };
  }
  const head = text.slice(0, limits.headChars);
  const budget = limits.maxChars - head.length;
  const mentions: string[] = [];
  let used = 0;
  for (const line of text.slice(limits.headChars).split("\n")) {
    if (mentions.length >= limits.maxMentionLines) break;
    const lower = line.toLowerCase();
    if (!mentionTokens.some((token) => lower.includes(token))) continue;
    const clipped = line.slice(0, limits.maxLineChars);
    if (used + clipped.length + 1 > budget) break;
    mentions.push(clipped);
    used += clipped.length + 1;
  }
  return {
    text: mentions.length > 0 ? `${head}\n…\n${mentions.join("\n")}` : head,
    sampled: true,
  };
}
```

- [ ] **Step 4: Implement `files-ai-prompt.ts`**

```ts
export interface FilesAiCriteria {
  name: string;
  email: string;
  personalEmail?: string;
  aliases: string[];
}

export const FILES_AI_MODEL = "gpt-4o-mini";

export const FILES_AI_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "dsar_files_decision",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["decision", "reason"],
      properties: {
        decision: { type: "string", enum: ["keep", "discard"] },
        reason: { type: "string", maxLength: 240 },
      },
    },
  },
} as const;

export function buildFilesAiSystemPrompt(criteria: FilesAiCriteria): string {
  return `You are an expert Legal AI performing a Data Subject Access Request (DSAR) relevance review of documents and chat messages.
Target Data Subject: ${criteria.name}
Primary Email (work): ${criteria.email}${criteria.personalEmail ? `\nPersonal Email: ${criteria.personalEmail}` : ""}
Aliases: ${criteria.aliases.join(", ")}

You receive one file (or, when marked SAMPLE, the start of a large file plus lines that mention the subject). Decide whether the file is relevant to the Data Subject: it is about them, written by them, sent to them, or contains their personal data in a way that matters to a subject access request.

Rules:
- Answer "discard" ONLY when the file is clearly unrelated to the Data Subject (for example a coincidental name match, a generic template, a system export that merely lists many people).
- When in doubt, answer "keep". Missing a relevant file is worse than keeping an irrelevant one.
- A SAMPLE that shows the subject in a meaningful context means "keep" for the whole file.
Return JSON: {"decision":"keep"|"discard","reason":"<one sentence>"}.`;
}

export function buildFilesAiUserContent(input: {
  fileName: string;
  kind: "Document" | "Message";
  sampled: boolean;
  text: string;
}): string {
  return `${input.sampled ? "SAMPLE of a large file" : "Full file text"} (${input.kind}): ${input.fileName}\n---\n${input.text}`;
}

export function buildFilesAiBatchRequest(input: {
  customId: string;
  systemPrompt: string;
  userContent: string;
}): object {
  return {
    custom_id: input.customId,
    method: "POST",
    url: "/v1/chat/completions",
    body: {
      model: FILES_AI_MODEL,
      messages: [
        { role: "system", content: input.systemPrompt },
        { role: "user", content: input.userContent },
      ],
      temperature: 0,
      max_completion_tokens: 120,
      response_format: FILES_AI_RESPONSE_FORMAT,
    },
  };
}

const KEEP_FALLBACK = {
  verdict: "keep" as const,
  reason: "Unparseable AI output; kept.",
};

export function parseFilesAiVerdict(raw: unknown): {
  verdict: "keep" | "discard";
  reason: string;
} {
  if (typeof raw !== "string") return KEEP_FALLBACK;
  const cleaned = raw
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/\s*```$/i, "");
  try {
    const data = JSON.parse(cleaned) as { decision?: unknown; reason?: unknown };
    if (data.decision !== "keep" && data.decision !== "discard") {
      return KEEP_FALLBACK;
    }
    const reason =
      typeof data.reason === "string" ? data.reason.slice(0, 240) : "";
    return { verdict: data.decision, reason };
  } catch {
    return KEEP_FALLBACK;
  }
}
```

- [ ] **Step 5: Run tests** → PASS. `npx biome check --write src scripts`.
- [ ] **Step 6: Commit** (`Add the Files AI sample builder, prompt and verdict parser`).

---

### Task 4: Reading text from this wave's delivered PDFs

**Files:**
- Create: `src/lib/files-ai-extract.ts`
- Test: `scripts/tests/unit/files-ai-extract.test.ts`

**Interfaces:**
- Consumes: `isUnfinalizedName(name: string, prefix: "Document" | "Message"): boolean` from `src/lib/request-waves.ts`; `FilesPrefix` type there.
- Produces:
  - `export interface FilesAiCandidate { relPath: string; kind: "Document" | "Message"; fileName: string; absPath: string }`
  - `export function listFilesAiCandidates(dirs: { messagesDir: string; documentsDir: string }): FilesAiCandidate[]` — only unfinalized `.pdf` names (this wave), files only, never inside `Unconverted/`, sorted with `localeCompare(..., {numeric:true})`.
  - `export async function readPdfText(absPath: string, maxPages?: number): Promise<string>` — returns `""` on any error (corrupt, image-only, password). Default `maxPages = 12`.

- [ ] **Step 1: Failing test**

```ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  listFilesAiCandidates,
  readPdfText,
} from "../../../src/lib/files-ai-extract";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "files-ai-"));
}

describe("listFilesAiCandidates", () => {
  it("lists only this wave's unfinalized PDFs", () => {
    const root = tmp();
    const docs = path.join(root, "Documents");
    const msgs = path.join(root, "Messages");
    fs.mkdirSync(path.join(docs, "Unconverted"), { recursive: true });
    fs.mkdirSync(msgs);
    fs.writeFileSync(path.join(docs, "Document 0001.pdf"), "x"); // earlier wave
    fs.writeFileSync(path.join(docs, "9f2c1a.pdf"), "x"); // this wave
    fs.writeFileSync(path.join(docs, "Unconverted", "big.xlsx"), "x");
    fs.writeFileSync(path.join(docs, ".hidden"), "x");
    fs.writeFileSync(path.join(msgs, "abc123.pdf"), "x");
    fs.writeFileSync(path.join(msgs, "Message 0001.pdf"), "x");
    const found = listFilesAiCandidates({
      documentsDir: docs,
      messagesDir: msgs,
    });
    assert.deepEqual(
      found.map((c) => c.relPath).sort(),
      ["Documents/9f2c1a.pdf", "Messages/abc123.pdf"],
    );
    assert.equal(found.find((c) => c.kind === "Message")?.fileName, "abc123.pdf");
  });

  it("returns [] when the folders do not exist", () => {
    const root = tmp();
    assert.deepEqual(
      listFilesAiCandidates({
        documentsDir: path.join(root, "nope"),
        messagesDir: path.join(root, "nada"),
      }),
      [],
    );
  });
});

describe("readPdfText", () => {
  it("returns empty text for a corrupt or non-PDF file", async () => {
    const root = tmp();
    const file = path.join(root, "bad.pdf");
    fs.writeFileSync(file, "this is not a pdf");
    assert.equal(await readPdfText(file), "");
  });

  it("returns empty text for a missing file", async () => {
    assert.equal(await readPdfText("/definitely/not/here.pdf"), "");
  });
});
```

- [ ] **Step 2: Run** `node --import tsx --test scripts/tests/unit/files-ai-extract.test.ts` → FAIL.
- [ ] **Step 3: Implement**

```ts
import fs from "node:fs";
import path from "node:path";
import { isUnfinalizedName } from "./request-waves";

export interface FilesAiCandidate {
  relPath: string;
  kind: "Document" | "Message";
  fileName: string;
  absPath: string;
}

function listFolder(
  dir: string,
  kind: "Document" | "Message",
  folderName: "Documents" | "Messages",
): FilesAiCandidate[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        !entry.name.startsWith(".") &&
        entry.name.toLowerCase().endsWith(".pdf") &&
        isUnfinalizedName(entry.name, kind),
    )
    .map((entry) => ({
      relPath: `${folderName}/${entry.name}`,
      kind,
      fileName: entry.name,
      absPath: path.join(dir, entry.name),
    }))
    .sort((a, b) =>
      a.fileName.localeCompare(b.fileName, undefined, { numeric: true }),
    );
}

export function listFilesAiCandidates(dirs: {
  messagesDir: string;
  documentsDir: string;
}): FilesAiCandidate[] {
  return [
    ...listFolder(dirs.documentsDir, "Document", "Documents"),
    ...listFolder(dirs.messagesDir, "Message", "Messages"),
  ];
}

/** Text of the first pages of a PDF, or "" when it cannot be read. */
export async function readPdfText(
  absPath: string,
  maxPages = 12,
): Promise<string> {
  try {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: fs.readFileSync(absPath) });
    try {
      const result = await parser.getText({
        partial: Array.from({ length: maxPages }, (_, i) => i + 1),
      });
      return (result.text ?? "").trim();
    } finally {
      await parser.destroy().catch(() => undefined);
    }
  } catch {
    return "";
  }
}
```

(Check the exact `PDFParse` call shape in `src/lib/converter.ts` around line 566 and copy it; adjust `getText` options to match the installed `pdf-parse` 2.x API.)

- [ ] **Step 4: Run tests** → PASS. Also add one test that creates a real text PDF if a PDF fixture exists in `scripts/tests` (otherwise skip; the live rehearsal in Task 9 covers real PDFs).
- [ ] **Step 5: Commit** (`Read the text of this wave's converted PDFs for the AI check`).

---

### Task 5: `files-ai.ts` — prepare, poll, apply verdicts, settled state

**Files:**
- Create: `src/lib/files-ai.ts`
- Test: `scripts/tests/db/files-ai.test.ts`

**Interfaces:**
- Consumes: Task 2 models, Task 3 functions, Task 4 functions, `getAiBatchSettings()` (`maxTokensPerBatch`), `runtimeCredentials()`, `js-tiktoken` `encodingForModel("gpt-4o-mini")`.
- Produces:
  - `export interface FilesAiClient { uploadBatchFile(path: string): Promise<string>; createBatch(inputFileId: string): Promise<string>; retrieveBatch(batchId: string): Promise<{ status: string; outputFileId?: string | null }>; readFile(fileId: string): Promise<string> }` — a thin seam over the OpenAI SDK so DB tests can stub it.
  - `export async function openAiFilesAiClient(): Promise<FilesAiClient>` — real implementation (`client.files.create({purpose:"batch"})`, `client.batches.create({endpoint:"/v1/chat/completions", completion_window:"24h"})`, `client.batches.retrieve`, `client.files.content(...).text()`); throws `"Configure the OpenAI API key in Settings."` when no key.
  - `export async function prepareFilesAi(input: { fileId: string; dirs: { messagesDir: string; documentsDir: string }; criteria: FilesAiCriteria; client: FilesAiClient; maxTokensPerBatch?: number; batchDir?: string }): Promise<{ candidates: number; queued: number; keptNoText: number; submittedBatches: number }>`
  - `export async function pollFilesAiBatches(fileId: string, client: FilesAiClient): Promise<void>`
  - `export async function getFilesAiState(fileId: string): Promise<{ total: number; resolved: number; pending: number; discards: number; activeRuns: number; failedRuns: number }>`
  - `export async function isFilesAiSettled(fileId: string): Promise<boolean>` — `pending === 0 && activeRuns === 0`.

Behavior spec (each bullet gets a test):
1. `prepareFilesAi` is idempotent: it only creates verdict rows for candidates that have none; existing verdicts (any state) are not recreated or resubmitted. A second call with the same files submits nothing.
2. A candidate whose `readPdfText` is `""` gets a verdict row immediately `{verdict:"keep", reason:"No extractable text; kept without AI review.", resolved_at: now}` and is **not** sent.
3. Verdict row id is `${fileId}:${relPath}`; `custom_id` in the JSONL is that id.
4. Candidates are chunked so each JSONL file's estimated tokens (tiktoken over system+user content, plus 24 request overhead and 12 per message) stays ≤ `maxTokensPerBatch`; one request is never split. A single request larger than the budget is **kept** (resolved immediately with reason "Too large to review; kept.").
5. Claim before submit: `updateMany` on that chunk's verdict rows `where {verdict: null, batch_run_id: null}` setting `batch_run_id`; skip rows with `count` mismatch. On submit failure (client throws) the run row is deleted, `batch_run_id` is reset to null, and the error is rethrown.
6. `pollFilesAiBatches`: for each `files_ai_batch_runs` row with `status in ("submitted","processing")` and `openai_batch_id`: `retrieveBatch`; if `completed` with `outputFileId` → read lines, for each line parse with `parseFilesAiVerdict(content)`; update the verdict row **only if `verdict` is still null** (`updateMany` where `{id, verdict: null}`), then any verdict rows of this run still null (missing from output) are resolved to `keep` ("No AI result returned; kept."); mark run `completed`. If `completed` without output, or status in `failed|expired|cancelled`: resolve that run's pending rows to `keep` ("AI batch failed; kept."), mark run `failed` with `error`. Other statuses leave it alone.
7. `getFilesAiState` counts as described; `discards` counts `verdict:"discard"`.

- [ ] **Step 1: Write failing DB tests** in `scripts/tests/db/files-ai.test.ts` using a `FakeClient` (records `createBatch` calls, returns canned output text) and temp dirs with real small files. Cover: (a) prepare queues 2 files and submits 1 batch; (b) second prepare submits nothing; (c) no-text PDF resolved to keep without being sent; (d) poll applies `{"decision":"discard"}` for one id and keeps garbage for another; (e) missing id in output resolves keep; (f) batch `failed` resolves pending keep; (g) client throwing in `createBatch` leaves no run row and releases the claim; (h) token chunking: with `maxTokensPerBatch: 200` and 3 medium files, ≥2 batches; (i) `isFilesAiSettled` false while a run is submitted, true after poll. Stub text extraction by passing real PDFs only where needed; for others add an optional dependency `readText?: (absPath: string) => Promise<string>` to `prepareFilesAi` input (default `readPdfText`) so tests inject text without PDFs.

- [ ] **Step 2: Run** `bash $SCRATCH/run-db-tests.sh scripts/tests/db/files-ai.test.ts` → FAIL.

- [ ] **Step 3: Implement `files-ai.ts`.** Core of `prepareFilesAi`:

```ts
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { encodingForModel } from "js-tiktoken";
import OpenAI from "openai";
import { runtimeCredentials } from "./credentials";
import {
  type FilesAiCandidate,
  listFilesAiCandidates,
  readPdfText,
} from "./files-ai-extract";
import {
  buildFilesAiBatchRequest,
  buildFilesAiSystemPrompt,
  buildFilesAiUserContent,
  FILES_AI_MODEL,
  type FilesAiCriteria,
  parseFilesAiVerdict,
} from "./files-ai-prompt";
import { buildSample, subjectMentionTokens } from "./files-ai-text";
import { DEFAULT_AI_BATCH_SETTINGS, getAiBatchSettings } from "./pipeline-settings";
import { prisma } from "./prisma";

const TOKENIZER = encodingForModel(FILES_AI_MODEL);
const REQUEST_OVERHEAD_TOKENS = 24;
const MESSAGE_OVERHEAD_TOKENS = 12;

export interface FilesAiClient { /* as in Interfaces above */ }

function verdictId(fileId: string, relPath: string): string {
  return `${fileId}:${relPath}`;
}

async function resolveKeep(id: string, reason: string): Promise<void> {
  await prisma.filesAiVerdict.updateMany({
    where: { id, verdict: null },
    data: { verdict: "keep", reason, resolved_at: new Date() },
  });
}

export async function prepareFilesAi(input: PrepareInput) {
  const { fileId, dirs, criteria, client } = input;
  const readText = input.readText ?? readPdfText;
  const maxTokens =
    input.maxTokensPerBatch ??
    (await getAiBatchSettings()).maxTokensPerBatch ??
    DEFAULT_AI_BATCH_SETTINGS.maxTokensPerBatch;
  const candidates = listFilesAiCandidates(dirs);
  const known = new Set(
    (
      await prisma.filesAiVerdict.findMany({
        where: { file_id: fileId },
        select: { rel_path: true },
      })
    ).map((row) => row.rel_path),
  );
  const systemPrompt = buildFilesAiSystemPrompt(criteria);
  const tokens = subjectMentionTokens(criteria);
  const systemTokens = TOKENIZER.encode(systemPrompt).length;

  let keptNoText = 0;
  const queue: Array<{ id: string; line: string; tokens: number }> = [];
  for (const candidate of candidates) {
    if (known.has(candidate.relPath)) continue;
    const id = verdictId(fileId, candidate.relPath);
    const text = await readText(candidate.absPath);
    if (!text.trim()) {
      await prisma.filesAiVerdict.create({
        data: {
          id, file_id: fileId, rel_path: candidate.relPath, verdict: "keep",
          reason: "No extractable text; kept without AI review.",
          resolved_at: new Date(),
        },
      });
      keptNoText++;
      continue;
    }
    const sample = buildSample(text, tokens);
    const userContent = buildFilesAiUserContent({
      fileName: candidate.fileName, kind: candidate.kind,
      sampled: sample.sampled, text: sample.text,
    });
    const estimate =
      systemTokens + TOKENIZER.encode(userContent).length +
      2 * MESSAGE_OVERHEAD_TOKENS + REQUEST_OVERHEAD_TOKENS;
    if (estimate > maxTokens) {
      await prisma.filesAiVerdict.create({
        data: {
          id, file_id: fileId, rel_path: candidate.relPath, verdict: "keep",
          reason: "Too large to review; kept.", sampled: sample.sampled,
          resolved_at: new Date(),
        },
      });
      continue;
    }
    await prisma.filesAiVerdict.create({
      data: { id, file_id: fileId, rel_path: candidate.relPath, sampled: sample.sampled },
    });
    queue.push({
      id,
      line: JSON.stringify(
        buildFilesAiBatchRequest({ customId: id, systemPrompt, userContent }),
      ),
      tokens: estimate,
    });
  }

  const chunks: Array<typeof queue> = [];
  let current: typeof queue = [];
  let currentTokens = 0;
  for (const item of queue) {
    if (current.length > 0 && currentTokens + item.tokens > maxTokens) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(item);
    currentTokens += item.tokens;
  }
  if (current.length > 0) chunks.push(current);

  for (const chunk of chunks) {
    await submitChunk(fileId, chunk, client, input.batchDir);
  }
  return {
    candidates: candidates.length,
    queued: queue.length,
    keptNoText,
    submittedBatches: chunks.length,
  };
}

async function submitChunk(
  fileId: string,
  chunk: Array<{ id: string; line: string; tokens: number }>,
  client: FilesAiClient,
  batchDir?: string,
): Promise<void> {
  const runId = randomUUID();
  const dir = batchDir ?? path.join(process.cwd(), "batches");
  fs.mkdirSync(dir, { recursive: true });
  const jsonlPath = path.join(dir, `files-ai-${runId}.jsonl`);
  await prisma.filesAiBatchRun.create({
    data: { id: runId, file_id: fileId, status: "claiming" },
  });
  try {
    const ids = chunk.map((item) => item.id);
    const claim = await prisma.filesAiVerdict.updateMany({
      where: { id: { in: ids }, verdict: null, batch_run_id: null },
      data: { batch_run_id: runId },
    });
    if (claim.count !== ids.length) {
      throw new Error("Files AI claim raced with another submitter.");
    }
    fs.writeFileSync(jsonlPath, `${chunk.map((i) => i.line).join("\n")}\n`);
    const inputFileId = await client.uploadBatchFile(jsonlPath);
    const batchId = await client.createBatch(inputFileId);
    await prisma.filesAiBatchRun.update({
      where: { id: runId },
      data: {
        status: "submitted",
        openai_batch_id: batchId,
        request_count: chunk.length,
        estimated_tokens: chunk.reduce((sum, i) => sum + i.tokens, 0),
        submitted_at: new Date(),
      },
    });
  } catch (error) {
    await prisma.filesAiVerdict.updateMany({
      where: { batch_run_id: runId, verdict: null },
      data: { batch_run_id: null },
    });
    await prisma.filesAiBatchRun.delete({ where: { id: runId } });
    throw error;
  } finally {
    fs.rmSync(jsonlPath, { force: true });
  }
}

export async function pollFilesAiBatches(
  fileId: string,
  client: FilesAiClient,
): Promise<void> {
  const runs = await prisma.filesAiBatchRun.findMany({
    where: {
      file_id: fileId,
      status: { in: ["submitted", "processing"] },
      openai_batch_id: { not: null },
    },
  });
  for (const run of runs) {
    const batch = await client.retrieveBatch(run.openai_batch_id as string);
    if (["failed", "expired", "cancelled"].includes(batch.status)) {
      await failRun(run.id, `OpenAI batch ${batch.status}.`);
      continue;
    }
    if (batch.status !== "completed") continue;
    if (!batch.outputFileId) {
      await failRun(run.id, "Batch completed without an output file.");
      continue;
    }
    const text = await client.readFile(batch.outputFileId);
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let parsed: {
        custom_id?: string;
        response?: { body?: { choices?: Array<{ message?: { content?: string } }> } };
      };
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!parsed.custom_id) continue;
      const verdict = parseFilesAiVerdict(
        parsed.response?.body?.choices?.[0]?.message?.content,
      );
      await prisma.filesAiVerdict.updateMany({
        where: { id: parsed.custom_id, verdict: null },
        data: { ...verdict, resolved_at: new Date() },
      });
    }
    // Anything the output did not mention is kept.
    await prisma.filesAiVerdict.updateMany({
      where: { batch_run_id: run.id, verdict: null },
      data: {
        verdict: "keep",
        reason: "No AI result returned; kept.",
        resolved_at: new Date(),
      },
    });
    await prisma.filesAiBatchRun.update({
      where: { id: run.id },
      data: { status: "completed", completed_at: new Date() },
    });
  }
}

async function failRun(runId: string, error: string): Promise<void> {
  await prisma.filesAiVerdict.updateMany({
    where: { batch_run_id: runId, verdict: null },
    data: {
      verdict: "keep",
      reason: "AI batch failed; kept.",
      resolved_at: new Date(),
    },
  });
  await prisma.filesAiBatchRun.update({
    where: { id: runId },
    data: { status: "failed", error, completed_at: new Date() },
  });
}

export async function getFilesAiState(fileId: string) {
  const [total, pending, discards, activeRuns, failedRuns] = await Promise.all([
    prisma.filesAiVerdict.count({ where: { file_id: fileId } }),
    prisma.filesAiVerdict.count({ where: { file_id: fileId, verdict: null } }),
    prisma.filesAiVerdict.count({
      where: { file_id: fileId, verdict: "discard" },
    }),
    prisma.filesAiBatchRun.count({
      where: {
        file_id: fileId,
        status: { in: ["claiming", "submitted", "processing"] },
      },
    }),
    prisma.filesAiBatchRun.count({
      where: { file_id: fileId, status: "failed" },
    }),
  ]);
  return {
    total,
    resolved: total - pending,
    pending,
    discards,
    activeRuns,
    failedRuns,
  };
}

export async function isFilesAiSettled(fileId: string): Promise<boolean> {
  const state = await getFilesAiState(fileId);
  return state.pending === 0 && state.activeRuns === 0;
}

export async function openAiFilesAiClient(): Promise<FilesAiClient> {
  const key = (await runtimeCredentials()).openAiKey;
  if (!key) throw new Error("Configure the OpenAI API key in Settings.");
  const openai = new OpenAI({ apiKey: key });
  return {
    async uploadBatchFile(filePath) {
      const upload = await openai.files.create({
        file: fs.createReadStream(filePath),
        purpose: "batch",
      });
      return upload.id;
    },
    async createBatch(inputFileId) {
      const batch = await openai.batches.create({
        input_file_id: inputFileId,
        endpoint: "/v1/chat/completions",
        completion_window: "24h",
      });
      return batch.id;
    },
    async retrieveBatch(batchId) {
      const batch = await openai.batches.retrieve(batchId);
      return { status: batch.status, outputFileId: batch.output_file_id };
    },
    async readFile(fileId) {
      return (await openai.files.content(fileId)).text();
    },
  };
}
```

The `FilesAiClient` interface (declared above in **Interfaces**) is exported from this file. Note: `getFilesAiState` counts a `"claiming"` run as active, and the run row is created *before* claiming so the verdict FK holds.

- [ ] **Step 4: Run tests** → PASS. `npx tsc --noEmit -p . && npx biome check --write src scripts`.
- [ ] **Step 5: Commit** (`Add the Files AI batch module (prepare, poll, settled state)`).

---

### Task 6: Applying verdicts — moving discards and the CSV (pure fs)

**Files:**
- Create: `src/lib/files-ai-apply.ts`
- Test: `scripts/tests/unit/files-ai-apply.test.ts`

**Interfaces:**
- Produces:
  - `export interface DiscardInput { relPath: string; reason: string }`
  - `export function applyDiscards(input: { requestOutputDir: string; discards: DiscardInput[] }): { moved: number; alreadyMoved: number }` — moves `<requestOutputDir>/<relPath>` to `<requestOutputDir>/Discarded/<relPath>` (creating dirs). If the source is gone and the destination exists → counts `alreadyMoved` (idempotent). If neither exists → ignored (not counted). Rejects (throws) any `relPath` that is absolute or contains `..` or does not start with `Documents/` or `Messages/`.
  - `export function writeVerdictsCsv(input: { requestOutputDir: string; rows: Array<{ relPath: string; verdict: string; reason: string }> }): string` — writes `Discarded/verdicts.csv` (header `file,verdict,reason`, RFC-4180 quoting), **replacing** the file each call; returns its path.

- [ ] **Step 1: Failing tests**: moves a discard into `Discarded/Documents/`; second call → `alreadyMoved: 1, moved: 0`; ignores a missing source; throws on `../escape.pdf`, `/abs/x.pdf`, `Emails/x.pdf`; CSV quotes commas, quotes and newlines in reasons; CSV rewritten (not appended) on a second call.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** with `fs.mkdirSync(..., {recursive:true})` + `fs.renameSync`; validate with `path.posix.normalize(relPath)` and a regex `^(Documents|Messages)\/[^/]+$`; CSV cell = `"` + value.replaceAll('"','""') + `"`.
- [ ] **Step 4: Run** → PASS; lint.
- [ ] **Step 5: Commit** (`Add the Files AI discard mover and verdict CSV`).

---

### Task 7: Control-plane gate, jobs and counters

**Files:**
- Modify: `src/lib/control-plane/job-store.ts` (add `getFilesStageJobState`)
- Modify: `src/lib/control-plane/phase-runner.ts` (two new branches before `filesFinalize`, ~line 300)
- Modify: `scripts/orchestrator/dispatcher.ts` (`settleFilesBatches`, ~lines 456-474)
- Create: `src/lib/files-ai-gate.ts`
- Test: `scripts/tests/db/files-ai-gate.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 5, 6; `enqueueFilePhase`, `recordFilesBatchResult`, `getFilesFinalizerState` pattern.
- Produces:
  - `job-store.ts`: `export async function getFilesStageJobState(fileId: string, runKey: string, stage: "filesAiPrepare" | "filesAiApply"): Promise<FilesFinalizerState>` — same SQL as `getFilesFinalizerState` but `payload->'metadata'->>'<stage>' = 'true'` (use a parameter for the key, validated against the two literals).
  - `files-ai-gate.ts`:
    - `export async function filesAiRequired(fileId: string): Promise<boolean>` — `settings.filesAiEnabled` **and** the row has a `case_request_id` **and** its case's `case_type !== "client"`.
    - `export type FilesAiGate = "waiting" | "ready" | "failed"`
    - `export async function advanceFilesAi(fileId: string, runKey: string): Promise<FilesAiGate>`

`advanceFilesAi` logic (each branch gets a test; DB tests use real `orchestrator_jobs` rows via `enqueueFilePhase`/job-store helpers as `revive-files-batches.test.ts` does):

```ts
export async function advanceFilesAi(fileId: string, runKey: string): Promise<FilesAiGate> {
  const prepare = await getFilesStageJobState(fileId, runKey, "filesAiPrepare");
  if (prepare.active > 0) return "waiting";
  if (prepare.completed === 0) {
    if (prepare.failed > 0) return "ready"; // prepare dead-lettered: deliver everything (AI never blocks delivery)
    await enqueueFilePhase({
      fileId, phase: "files",
      dedupeKey: `files-ai-prepare:${fileId}:${runKey}`,
      metadata: { filesAiPrepare: true, runKey },
    });
    return "waiting";
  }
  if (!(await isFilesAiSettled(fileId))) return "waiting"; // poller is working
  const apply = await getFilesStageJobState(fileId, runKey, "filesAiApply");
  if (apply.active > 0) return "waiting";
  if (apply.failed > 0) return "failed"; // apply may have partially moved files: fail loudly
  if (apply.completed > 0) return "ready";
  await enqueueFilePhase({
    fileId, phase: "files",
    dedupeKey: `files-ai-apply:${fileId}:${runKey}`,
    metadata: { filesAiApply: true, runKey },
  });
  return "waiting";
}
```

Dispatcher change (inside `if (state.completed > 0) {` before the finalizer lookup):

```ts
if (await filesAiRequired(row.id)) {
  const gate = await advanceFilesAi(row.id, state.runKey);
  if (gate === "failed") {
    await prisma.processedFile.update({ where: { id: row.id }, data: { files_status: "failed" } });
    continue;
  }
  if (gate === "waiting") continue;
}
```

phase-runner branches (placed before `if (filesFinalize)`; both compute `directories` like the finalize branch does, plus `requestOutputDir = path.join(outputBase, requestPath)`):

Code for both branches (inside `runPhaseJob`'s Files section, with `row`, `fileId`, `outputBase`, `requestPath` already in scope):

```ts
const requestOutputDir = path.join(outputBase, requestPath);
const aiDirs = {
  messagesDir: path.join(requestOutputDir, "Messages"),
  documentsDir: path.join(requestOutputDir, "Documents"),
};

if (job.payload.metadata?.filesAiPrepare === true) {
  const client = await openAiFilesAiClient().catch(() => null);
  if (!client) {
    console.warn("[Files AI] No OpenAI key; delivering everything.");
    return { operation: "files-ai-skipped" };
  }
  try {
    const result = await prepareFilesAi({
      fileId,
      dirs: aiDirs,
      criteria: {
        name: subjectName,
        email: row.subject_email,
        personalEmail: subjectPersonalEmail ?? undefined,
        aliases: subjectAliases
          .split(",")
          .map((alias) => alias.trim())
          .filter(Boolean),
      },
      client,
    });
    return { operation: "files-ai-prepared", ...result };
  } catch (error) {
    console.warn(`[Files AI] prepare failed: ${error}; delivering everything.`);
    await prisma.filesAiVerdict.updateMany({
      where: { file_id: fileId, verdict: null },
      data: { verdict: "keep", reason: "AI step failed; kept.", resolved_at: new Date() },
    });
    return { operation: "files-ai-prepare-failed" };
  }
}

if (job.payload.metadata?.filesAiApply === true) {
  const verdicts = await prisma.filesAiVerdict.findMany({
    where: { file_id: fileId, verdict: "discard" },
    select: { rel_path: true, reason: true },
  });
  const discards = verdicts.map((v) => ({
    relPath: v.rel_path,
    reason: v.reason ?? "",
  }));
  const moved = applyDiscards({ requestOutputDir, discards });
  if (discards.length > 0) {
    writeVerdictsCsv({
      requestOutputDir,
      rows: discards.map((d) => ({
        relPath: d.relPath,
        verdict: "discard",
        reason: d.reason,
      })),
    });
  }
  const totals = await recordFilesBatchResult({
    jobId: job.id,
    fileId,
    processed: -discards.length,
    skipped: discards.length,
    duplicates: 0,
  });
  await prisma.processedFile.update({
    where: { id: fileId },
    data: {
      files_processed: totals.processed,
      files_skipped: totals.skipped,
      files_duplicates: totals.duplicates,
    },
  });
  return { operation: "files-ai-applied", discarded: discards.length, ...moved };
}
```

Behavior notes: `filesAiPrepare` — load criteria exactly like the coordinator does (row subject columns, falling back to `case`), `const client = await openAiFilesAiClient().catch(() => null)`; if `client` is null → log "[Files AI] No OpenAI key; delivering everything." and return `{ operation: "files-ai-skipped" }` (the job completes; with no verdict rows `isFilesAiSettled` is true, apply finds zero discards → ready). Otherwise `await prepareFilesAi({ fileId, dirs: directories, criteria, client })` wrapped in try/catch: on error log `[Files AI] prepare failed: …; delivering everything.`, resolve any pending verdicts to keep, and return normally. Then `startBatchPoller` is not available in the worker, so the app poller finds the runs (Task 8).
- `filesAiApply`: read all verdict rows; `discards = rows.filter(v => v.verdict === "discard")`; `applyDiscards({ requestOutputDir, discards })`; `writeVerdictsCsv` for **all discarded rows** (and, if any, still-pending rows resolved as keep are omitted); then counters: `recordFilesBatchResult({ jobId: job.id, fileId, processed: -discards.length, skipped: discards.length, duplicates: 0 })` returns the new totals — write them to `processed_files` with the same `prisma.processedFile.update` fields the batch path uses for `files_processed`, `files_skipped`, `files_duplicates` (copy from the batch branch near `recordFilesBatchResult` usage at phase-runner.ts ~line 560). Because `recordFilesBatchResult` is `ON CONFLICT (job_id) DO NOTHING`, a re-run does not double count; `applyDiscards` is idempotent.

- [ ] **Step 1: Failing DB tests** (`files-ai-gate.test.ts`): `filesAiRequired` false for setting off and for a client case, true for an employee case; `advanceFilesAi` sequence: no jobs → enqueues prepare, returns `waiting`; prepare job completed + a submitted run → `waiting`; prepare completed + settled + no apply → enqueues apply; apply completed → `ready`; prepare dead-lettered → `ready`; apply dead-lettered → `failed`; calling twice never enqueues a duplicate (dedupe key). Counter test: apply with 2 discards on totals `{processed: 10, skipped: 5}` → `{8, 7}`, a second apply call changes nothing.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `getFilesStageJobState`, `files-ai-gate.ts`, the two phase-runner branches and the dispatcher gate as above. Dispatcher memory: `filesAiPrepare`/`filesAiApply` jobs are `phase: "files"` with default (regular) container memory; make sure `memoryMbForJob` / the large-lane selector (`largeOfficeBatch`) are not triggered (they key on `largeOfficeBatch`, which these jobs lack).
- [ ] **Step 4: Run** all DB tests serially: `bash $SCRATCH/run-db-tests.sh` → PASS (existing 60 + new). `npx tsc --noEmit -p . && npx biome check --write src scripts`.
- [ ] **Step 5: Commit** (`Gate Files finalize behind the AI relevance check`).

---

### Task 8: Poller integration and UI progress

**Files:**
- Modify: `src/lib/batch-scheduler.ts` (`runBatchSweep`, "remaining" check)
- Modify: `src/app/api/cases/route.ts` (Files phase detail)
- Modify: `src/components/dashboard/CaseManager.tsx` (`phaseCards`, Files label)
- Modify: `src/lib/types.ts` / phase type in `CaseManager.tsx` (`RequestItem.phaseProgress`)
- Test: `scripts/tests/db/files-ai-poll.test.ts`, `scripts/tests/unit/phase-status.test.ts` (extend if the Files label logic is there)

**Interfaces:**
- Consumes: `pollFilesAiBatches`, `openAiFilesAiClient`, `getFilesAiState`.
- Produces: `phaseProgress.files.ai?: { done: number; total: number }` from `/api/cases`; Files tile label "AI review" while `files.status === "processing"` and `ai.total > 0 && ai.done < ai.total`.

- [ ] **Step 1: Failing DB test**: with a `files_ai_batch_runs` row `submitted` and a stub client injected, `runBatchSweep`'s new helper `pollFilesAiRuns(client?)` polls it; `workRemains` stays true while a Files AI run is active and while pending verdicts exist. Export a testable helper `async function pollFilesAiRuns(clientFactory = openAiFilesAiClient)` from `batch-scheduler.ts`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** In `runBatchSweep`, after the email polling loop:

```ts
const filesAiRuns = await prisma.filesAiBatchRun.findMany({
  where: { status: { in: ["submitted", "processing"] }, openai_batch_id: { not: null } },
  select: { file_id: true },
  distinct: ["file_id"],
});
if (filesAiRuns.length > 0) {
  try {
    const client = await openAiFilesAiClient();
    for (const run of filesAiRuns) await pollFilesAiBatches(run.file_id, client);
  } catch (err) {
    console.error("[Batch Scheduler] Files AI poll failed:", err);
  }
}
```

and extend the `remaining` query with `OR` a check `prisma.filesAiBatchRun.findFirst({ where: { status: { in: ["claiming","submitted","processing"] } } })`. A key failure must not wedge delivery: if the client cannot be created for a run older than 30 minutes, resolve its pending verdicts to keep and mark the run `failed` (add this to `pollFilesAiRuns`, with a test).
`/api/cases` route: add `ai: { done: resolved, total }` to `files` from `getFilesAiState(filesRow.id)` (only when `total > 0`). `phaseCards`: for the Files card, when `state.ai && state.status === "processing" && state.ai.done < state.ai.total`, set `label: "AI review"` and `detail: \`${state.ai.done}/${state.ai.total} reviewed\``.
- [ ] **Step 4: Run** DB tests + `node --import tsx --test scripts/tests/unit/*.test.ts` → PASS; `npx tsc --noEmit -p .`; lint.
- [ ] **Step 5: Commit** (`Poll Files AI batches and show their progress`).

---

### Task 9: Retry, rehearsal and rollout

**Files:**
- Modify: `src/lib/retry-targets.ts` / `/api/retry` only if the Files retry does not already clear AI state (see Step 1)
- Create: `scripts/maintenance/files-ai-rehearsal.ts` (read-only dry run)
- Docs: `AGENTS.md` (one bullet under Project Conventions describing the Files AI gate and `Discarded/`)

- [ ] **Step 1: Retry safety.** Read `/api/retry` and `reopenRequestForRetry` for Files. A Files retry clears the wave's Messages/Documents and re-runs the coordinator with a new `runKey`. Add a failing DB test that after a Files retry the old `files_ai_verdicts` / `files_ai_batch_runs` for that `file_id` are deleted (so a re-run re-judges fresh output), then delete them in the Files-retry path (`prisma.filesAiVerdict.deleteMany({ where: { file_id } })` and the same for runs, before clearing results). Verify with the test.
- [ ] **Step 2: Rehearsal script.** `scripts/maintenance/files-ai-rehearsal.ts <requestOutputDir> <subjectName> [aliases…]` lists candidates (Task 4), builds samples (Task 3), prints counts (candidates, no-text, sampled, estimated tokens and cost at gpt-4o-mini batch prices) and the first 5 prompts, and **does not call OpenAI or touch the DB**. Run it against a copy/listing of JW R1's `Documents` and `Messages` (these are finalized names, so run with a `--include-finalized` flag that bypasses `isUnfinalizedName`) to confirm text extraction works on real PDFs and to size the cost.
- [ ] **Step 3: Live rehearsal on a small case.** Create a tiny Files-only employee request (a dozen documents, some clearly unrelated), run it, and verify: AI step appears on the Files tile, `Discarded/` contains the unrelated files plus `verdicts.csv`, delivered numbering has no gaps, counters add up (processed + skipped + dups = handled), the SharePoint upload excludes `Discarded/`. Then run the same request with the setting off and confirm behavior is identical to today.
- [ ] **Step 4: Full verification.** `npm test`, `bash $SCRATCH/run-db-tests.sh`, `npx tsc --noEmit -p .`, `npx biome check src scripts prisma`. All green.
- [ ] **Step 5: AGENTS.md** — add under Project Conventions: "Files AI gate: `settleFilesBatches` runs `filesAiPrepare` → (poller) → `filesAiApply` between the Files batches and finalize. Only unfinalized (this wave's) PDFs are judged; `discard` moves a file to `<request>/Discarded/`, counts as skipped, and every error keeps the file. Client cases never run it. Setting: `files_ai_enabled` (System settings)."
- [ ] **Step 6: Merge and deploy** only after the user says so (they approved the design, not the deploy): merge `files-ai-relevance` to `main`, `docker compose up -d --build app dispatcher`, confirm `prisma migrate deploy` applied both migrations, then re-check the dispatcher log.
- [ ] **Step 7: Commit** (`Clear Files AI state on retry, add rehearsal script and docs`).

---

## Self-Review

**Spec coverage:** verdict = exclude to `Discarded/` with reasons (Tasks 5, 6, 7); scope = all cases with System toggle, client skipped (Tasks 1, 7); JW R1 not re-judged (Global Constraints, nothing touches it); isolated tables + module reusing Batch client/poller (Tasks 2, 5, 8); discard counts as skipped (Task 7 counters); large files sampled, `keep` verdict leaves the file as is (Tasks 3, 5); keep-on-error everywhere (Tasks 3, 5, 7, 8); retry idempotency (Tasks 5, 7, 9); UI progress and toggle (Tasks 1, 8); testing section incl. rehearsal (Task 9). Spec section 1 (sidecars) is replaced by PDF text extraction; flagged at the top.

**Placeholder scan:** Task 5 and Task 7 now contain the full code. Task 2's migration SQL is generated by `prisma migrate diff`, not hand-written. Names are consistent across tasks (`prepareFilesAi`, `pollFilesAiBatches`, `getFilesAiState`, `isFilesAiSettled`, `advanceFilesAi`, `filesAiRequired`, `applyDiscards`, `writeVerdictsCsv`).

**Risks the executor should watch:** `pdf-parse` 2.x call shape (copy from `converter.ts`); the table name for `PipelineSettings` in the migration; `recordFilesBatchResult` accepting negative `processed` (it sums columns, so it does; add a test); `settleFilesBatches` runs every dispatcher tick, so `advanceFilesAi` must stay cheap and idempotent.
