# Request Waves Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one request be continued in numbered waves so a case larger than the disk can be processed in parts into one deduplicated output folder with continued `Email NNNN` numbering.

**Architecture:** Add a `wave` counter to requests and source rows. Cross-wave dedup falls out of the existing `email_hash` scope (same request) as long as the email rows survive, so the scanner's prune step is made to keep rendered rows of managed requests. Coordinator/sibling lookups are scoped to (request, wave). Render stores a per-wave numbering base (highest existing `Email`/`Warning` number) on the request and numbers from it. A new Continue action reopens a completed request for the next wave.

**Tech Stack:** Next.js 16 (App Router route handlers), Prisma 7 (PostgreSQL), Node `node:test` run through `tsx`, Biome, React client component (`CaseManager.tsx`).

**Spec:** `docs/superpowers/specs/2026-10-05-request-waves-design.md`

## Global Constraints

- Single-wave requests (mail, files, both) must behave exactly as today. Wave 1 row ids keep the existing formula `sha256("{requestId}:{fullPath}").slice(0,24)`.
- Prisma-native queries only; no `$queryRaw`/`$executeRaw`. Multi-step atomic work uses `prisma.$transaction`.
- No hardcoded absolute paths in committed code; read paths from `process.env` or from stored request paths.
- Next.js 16 route handlers use `context: { params: Promise<{ requestId: string }> }` and `await params` (copy the pattern in `src/app/api/requests/[requestId]/reset/route.ts`).
- Lint/format with Biome: `npx biome check <files>` / `npx biome format --write <files>`. Types: `npx tsc --noEmit`.
- Tests use Node's built-in runner through tsx. Pure tests live in `scripts/tests/unit/` and run on the host with `npm test`. Database tests live in `scripts/tests/db/` and must run **inside the app container** (`src/lib/prisma.ts` hardcodes the `postgres` service host); they create rows with unique ids and delete them in `after()`.
- Commit messages end with: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Never start/restart the Docker stack, push, or run a real pipeline without the user's go-ahead; the final smoke test with real PSTs is user-run.

## Review Focus

- A wave-2 PST with the same filename/path as a wave-1 PST must get a different row id (no collision, wave 1 data intact) — pinned in Task 1.
- Number-width boundary: delivered `Email 9999.pdf` then 2 more emails must produce `Email 10000`/`Email 10001` without renaming old files — pinned in Task 1.
- Deleting a finished wave's PSTs then running the scanner must not remove its rows/hashes; deleting a PST of an unfinished row still prunes — pinned in Tasks 1 and 3.
- A Render retry inside the same wave reuses its stored base (no number shift, no duplicate PDFs) even after some PDFs already exist — pinned in Task 6.
- Wave 1 must never scan for a base (a retried wave-1 render with partial PDFs must keep numbering from 1) — pinned in Task 6.
- Continue on a non-completed request, or a double click, must not bump the wave twice — pinned in Task 5.
- Empty `Emails/` or missing `Warning/` folder yields base 0 — pinned in Tasks 1 and 6.

---

## File Structure

- Create `src/lib/request-waves.ts` — pure helpers (scope union, row ids, number parsing/width, prune predicate, leftover cleanup). No database access.
- Create `src/lib/render-numbering.ts` — database-bound `resolveRenderBases`.
- Create `scripts/tests/unit/request-waves.test.ts`, `scripts/tests/db/case-utils.test.ts`, `scripts/tests/db/waves.test.ts`.
- Create `src/app/api/requests/[requestId]/continue/route.ts`.
- Create `prisma/migrations/20261005120000_add_request_waves/migration.sql`.
- Modify `prisma/schema.prisma`, `package.json` (test scripts), `src/lib/staging.ts`, `src/lib/case-utils.ts`, `src/lib/cases.ts`, `src/lib/converter.ts`, `src/app/api/cases/route.ts`, `src/app/api/requests/[requestId]/reset/route.ts`, `src/components/dashboard/CaseManager.tsx`, `README.md`.

---

### Task 1: Pure wave helpers and the test runner

**Files:**
- Create: `src/lib/request-waves.ts`
- Create: `scripts/tests/unit/request-waves.test.ts`
- Modify: `package.json` (add scripts)

**Interfaces:**
- Produces (used by Tasks 3, 5, 6):
  - `type WaveScope = "mail" | "files" | "both"`
  - `unionScope(left: string, right: string): WaveScope`
  - `waveRowId(requestId: string, wave: number, fullPath: string): string`
  - `type NumberedPrefix = "Email" | "Warning"`
  - `highestNumber(names: string[], prefix: NumberedPrefix): number`
  - `numberWidth(names: string[], prefix: NumberedPrefix, finalNumber: number): number`
  - `formatNumber(value: number, width: number): string`
  - `interface PruneCandidate { id: string; filepath: string | null; case_request_id: string | null; kind: string; pdf_status: string; files_status: string }`
  - `isRenderedSourceRow(row: PruneCandidate): boolean`
  - `rowsToPrune<T extends PruneCandidate>(rows: T[], exists: (filepath: string) => boolean): T[]`
  - `removeOutputAbove(directory: string, prefix: NumberedPrefix, base: number): number`

- [ ] **Step 1: Write the failing test**

Create `scripts/tests/unit/request-waves.test.ts`:

```ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  formatNumber,
  highestNumber,
  isRenderedSourceRow,
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
    assert.equal(highestNumber(["Warning 03.pdf", "Warning 11.pdf"], "Warning"), 11);
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
      isRenderedSourceRow({ ...base, kind: "files", files_status: "completed", pdf_status: "pending" }),
      true,
    );
  });
  it("does not protect unfinished or legacy rows", () => {
    assert.equal(isRenderedSourceRow({ ...base, pdf_status: "processing" }), false);
    assert.equal(isRenderedSourceRow({ ...base, case_request_id: null }), false);
  });
  it("prunes missing unfinished rows but keeps missing rendered ones", () => {
    const rows = [
      base,
      { ...base, id: "b", pdf_status: "pending" },
      { ...base, id: "c", filepath: "/present.pst", pdf_status: "pending" },
      { ...base, id: "d", filepath: null, pdf_status: "pending" },
    ];
    const pruned = rowsToPrune(rows, (p) => p === "/present.pst").map((r) => r.id);
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
```

- [ ] **Step 2: Add the test scripts and run to verify failure**

In `package.json` `scripts`, add:

```json
"test": "node --import tsx --test scripts/tests/unit/*.test.ts",
"test:db": "node --import tsx --test scripts/tests/db/*.test.ts",
```

Run: `npm test`
Expected: FAIL — `Cannot find module '../../../src/lib/request-waves'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/request-waves.ts`:

```ts
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type WaveScope = "mail" | "files" | "both";
export type NumberedPrefix = "Email" | "Warning";

const SCOPES: readonly string[] = ["mail", "files", "both"];

/** Widens two request scopes into the smallest scope covering both. */
export function unionScope(left: string, right: string): WaveScope {
  if (!SCOPES.includes(left) || !SCOPES.includes(right)) {
    throw new Error("Scope must be mail, files, or both.");
  }
  const mail = left !== "files" || right !== "files";
  const files = left !== "mail" || right !== "mail";
  return mail && files ? "both" : mail ? "mail" : "files";
}

/**
 * Source-row id. Wave 1 keeps the historical formula so existing data is
 * untouched; later waves include the wave number so an identically named PST
 * in a new wave can never collide with the earlier one.
 */
export function waveRowId(
  requestId: string,
  wave: number,
  fullPath: string,
): string {
  const seed =
    wave <= 1
      ? `${requestId}:${fullPath}`
      : `${requestId}:w${wave}:${fullPath}`;
  return crypto.createHash("sha256").update(seed).digest("hex").slice(0, 24);
}

function numberPattern(prefix: NumberedPrefix): RegExp {
  return new RegExp(`^${prefix} (\\d+)\\b`);
}

/** Highest `Email N` / `Warning N` among directory entry names (0 if none). */
export function highestNumber(
  names: string[],
  prefix: NumberedPrefix,
): number {
  const pattern = numberPattern(prefix);
  let highest = 0;
  for (const name of names) {
    const match = pattern.exec(name);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest;
}

/**
 * Zero-pad width for the final number, never narrower than files already
 * delivered. Existing files are never renamed when the width grows.
 */
export function numberWidth(
  names: string[],
  prefix: NumberedPrefix,
  finalNumber: number,
): number {
  const pattern = numberPattern(prefix);
  let width = String(Math.max(1, finalNumber)).length;
  for (const name of names) {
    const match = pattern.exec(name);
    if (match) width = Math.max(width, match[1].length);
  }
  return width;
}

export function formatNumber(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

export interface PruneCandidate {
  id: string;
  filepath: string | null;
  case_request_id: string | null;
  kind: string;
  pdf_status: string;
  files_status: string;
}

/**
 * A managed request's source row that finished rendering is kept even when its
 * source file is gone: its email hashes are the dedup memory for later waves.
 */
export function isRenderedSourceRow(row: PruneCandidate): boolean {
  if (!row.case_request_id) return false;
  return row.kind === "files"
    ? row.files_status === "completed"
    : row.pdf_status === "completed";
}

export function rowsToPrune<T extends PruneCandidate>(
  rows: T[],
  exists: (filepath: string) => boolean,
): T[] {
  return rows.filter(
    (row) =>
      (!row.filepath || !exists(row.filepath)) && !isRenderedSourceRow(row),
  );
}

/** Removes top-level `<prefix> N…` entries numbered above `base`. */
export function removeOutputAbove(
  directory: string,
  prefix: NumberedPrefix,
  base: number,
): number {
  if (!fs.existsSync(directory)) return 0;
  const pattern = numberPattern(prefix);
  let removed = 0;
  for (const name of fs.readdirSync(directory)) {
    const match = pattern.exec(name);
    if (match && Number(match[1]) > base) {
      fs.rmSync(path.join(directory, name), { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (all `describe` blocks).

- [ ] **Step 5: Lint, types, commit**

Run: `npx biome format --write src/lib/request-waves.ts scripts/tests/unit/request-waves.test.ts package.json && npx biome check src/lib/request-waves.ts scripts/tests package.json && npx tsc --noEmit`
Expected: no errors.

```bash
git add src/lib/request-waves.ts scripts/tests/unit/request-waves.test.ts package.json docs/superpowers
git commit -m "Add pure helpers for request waves" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Schema and migration

**Files:**
- Modify: `prisma/schema.prisma` (models `ProcessedFile`, `CaseRequest`)
- Create: `prisma/migrations/20261005120000_add_request_waves/migration.sql`

**Interfaces:**
- Produces: Prisma fields `ProcessedFile.wave: number`, `CaseRequest.wave: number`, `CaseRequest.wave_scope: string | null`, `CaseRequest.render_base: number | null`, `CaseRequest.warning_base: number | null`.

- [ ] **Step 1: Edit the schema**

In `model ProcessedFile`, after `case_request_id         String?` add:

```prisma
  wave                    Int      @default(1)
```

and before `@@map("processed_files")` add `@@index([case_request_id, wave])`.

In `model CaseRequest`, after `error                 String?` add:

```prisma
  wave                  Int           @default(1)
  wave_scope            String?
  render_base           Int?
  warning_base          Int?
```

- [ ] **Step 2: Write the migration**

Create `prisma/migrations/20261005120000_add_request_waves/migration.sql`:

```sql
ALTER TABLE "processed_files" ADD COLUMN "wave" INTEGER NOT NULL DEFAULT 1;
CREATE INDEX "processed_files_case_request_id_wave_idx" ON "processed_files"("case_request_id", "wave");

ALTER TABLE "case_requests"
ADD COLUMN "wave" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "wave_scope" TEXT,
ADD COLUMN "render_base" INTEGER,
ADD COLUMN "warning_base" INTEGER;
```

- [ ] **Step 3: Validate and regenerate the client**

Run: `npx prisma validate && npx prisma generate`
Expected: "The schema ... is valid" and a generated client.

- [ ] **Step 4: Type check**

Run: `npx tsc --noEmit`
Expected: no errors (the new fields are optional/defaulted, existing code is unaffected).

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20261005120000_add_request_waves
git commit -m "Add wave columns to processed files and case requests" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

(The migration is applied by the app container's `npx prisma migrate deploy` on the next start; it is additive with defaults, so the currently running old code keeps working.)

---

### Task 3: Prune protection

**Files:**
- Modify: `src/lib/staging.ts` (function `pruneMissingRows`)

**Interfaces:**
- Consumes: `rowsToPrune`, `PruneCandidate` from `src/lib/request-waves.ts` (Task 1).

- [ ] **Step 1: Confirm the predicate test already pins behavior**

Run: `npm test`
Expected: PASS — the `prune protection` tests from Task 1 already specify the rule (rendered managed rows kept, unfinished/legacy rows pruned).

- [ ] **Step 2: Use the predicate in `pruneMissingRows`**

In `src/lib/staging.ts` add the import:

```ts
import { rowsToPrune } from "./request-waves";
```

Replace the start of `pruneMissingRows`:

```ts
  const rows = await prisma.processedFile.findMany({
    select: { id: true, filepath: true },
  });

  const missingRows = rows.filter(
    (item) => !item.filepath || !fs.existsSync(item.filepath),
  );
```

with:

```ts
  const rows = await prisma.processedFile.findMany({
    select: {
      id: true,
      filepath: true,
      case_request_id: true,
      kind: true,
      pdf_status: true,
      files_status: true,
    },
  });

  // Rows of a managed request that already finished rendering are kept even
  // when their source is gone: their email hashes are the dedup memory that
  // later waves rely on, and deleting finished PSTs to free disk is expected.
  const missingRows = rowsToPrune(rows, (filepath) => fs.existsSync(filepath));
```

(The rest of the function — history snapshots and the delete transaction — is unchanged and now only sees the pruned rows.)

- [ ] **Step 3: Lint and types**

Run: `npx biome check src/lib/staging.ts && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/staging.ts
git commit -m "Keep rendered request rows when their source files are deleted" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Wave-scoped coordinator lookups

**Files:**
- Modify: `src/lib/case-utils.ts` (function `getCasePstFileIds`)
- Create: `scripts/tests/db/case-utils.test.ts`

**Interfaces:**
- Consumes: Prisma `ProcessedFile.wave`, `case_request_id` (Task 2).
- Produces: `getCasePstFileIds(fileId)` now returns the PST rows of the same request **and wave** for managed rows. Legacy rows (no `case_request_id`) keep the folder-key behavior. `isCaseAiSettled`, `markCaseAiCompleted/Failed`, the converter, `batch-scheduler` (coordinator = sorted ids [0]) and `ai.ts` all inherit this.

- [ ] **Step 1: Write the failing database test**

Create `scripts/tests/db/case-utils.test.ts`:

```ts
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, describe, it } from "node:test";
import { getCasePstFileIds } from "../../../src/lib/case-utils";
import { prisma } from "../../../src/lib/prisma";

const tag = crypto.randomUUID().slice(0, 8);
const caseId = `t-case-${tag}`;
const requestId = `t-req-${tag}`;
const ids = {
  w1a: `t-w1a-${tag}`,
  w1b: `t-w1b-${tag}`,
  w2a: `t-w2a-${tag}`,
  w2b: `t-w2b-${tag}`,
};

describe("getCasePstFileIds is scoped to request and wave", () => {
  before(async () => {
    await prisma.managedCase.create({
      data: {
        id: caseId,
        name: `ZZ-WAVE-${tag}`,
        subject_name: "T",
        subject_email: "t@example.com",
      },
    });
    await prisma.caseRequest.create({
      data: {
        id: requestId,
        case_id: caseId,
        name: "R1",
        scope: "mail",
        staging_path: `/nonexistent/${tag}/Staging/R1`,
        deliverable_path: `/nonexistent/${tag}/Results/R1`,
        wave: 2,
      },
    });
    for (const [key, wave] of [
      ["w1a", 1],
      ["w1b", 1],
      ["w2a", 2],
      ["w2b", 2],
    ] as const) {
      await prisma.processedFile.create({
        data: {
          id: ids[key],
          filename: `${key}.pst`,
          filepath: `/nonexistent/${tag}/Staging/R1/PST/${key}.pst`,
          kind: "pst",
          case_request_id: requestId,
          wave,
        },
      });
    }
  });

  after(async () => {
    await prisma.processedFile.deleteMany({
      where: { case_request_id: requestId },
    });
    await prisma.caseRequest.deleteMany({ where: { id: requestId } });
    await prisma.managedCase.deleteMany({ where: { id: caseId } });
    await prisma.$disconnect();
  });

  it("returns only the current wave's PST rows", async () => {
    assert.deepEqual((await getCasePstFileIds(ids.w2a)).sort(), [
      ids.w2a,
      ids.w2b,
    ]);
  });

  it("does not mix earlier waves into a later coordinator", async () => {
    assert.deepEqual((await getCasePstFileIds(ids.w1a)).sort(), [
      ids.w1a,
      ids.w1b,
    ]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

The test needs the Task 2 migration applied to the dev database and runs in the container. Apply and run (this restarts nothing; `docker cp` only copies files into the running app container):

```bash
docker compose exec -T app npx prisma migrate deploy
docker cp prisma "$(docker compose ps -q app)":/workspace/prisma
docker cp src "$(docker compose ps -q app)":/workspace/src
docker cp scripts/tests "$(docker compose ps -q app)":/workspace/scripts/tests
docker compose exec -T app npx prisma generate
docker compose exec -T app npm run test:db
```

Expected: FAIL — the wave-2 lookup currently returns all four ids (folder key), so the first assertion fails.

- [ ] **Step 3: Implement**

Replace the body of `getCasePstFileIds` in `src/lib/case-utils.ts` with:

```ts
export async function getCasePstFileIds(fileId: string): Promise<string[]> {
  const row = await prisma.processedFile.findUnique({
    where: { id: fileId },
    select: { filepath: true, case_request_id: true, wave: true },
  });
  if (!row?.filepath) return [fileId];

  // Managed requests run in waves: siblings are the PST rows of the same
  // request AND wave, so a finished earlier wave never becomes the coordinator
  // of, or blocks, the current one.
  if (row.case_request_id) {
    const siblings = await prisma.processedFile.findMany({
      where: {
        kind: "pst",
        case_request_id: row.case_request_id,
        wave: row.wave,
      },
      select: { id: true },
    });
    return siblings.length > 0 ? siblings.map((r) => r.id) : [fileId];
  }

  const caseKey = getCaseKey(row.filepath);
  const rows = await prisma.processedFile.findMany({
    where: { kind: "pst" },
    select: { id: true, filepath: true },
  });

  const ids = rows
    .filter((r) => r.filepath && getCaseKey(r.filepath) === caseKey)
    .map((r) => r.id);

  return ids.length > 0 ? ids : [fileId];
}
```

Also update the doc comment above the function group: change "A "case" here = all `kind='pst'` rows in the same `[case]/[request]`." to "...in the same `[case]/[request]` and, for managed requests, the same wave."

- [ ] **Step 4: Run to verify it passes**

```bash
docker cp src "$(docker compose ps -q app)":/workspace/src
docker compose exec -T app npm run test:db
```

Expected: PASS (2 tests); no `t-*` rows remain (`docker compose exec -T postgres psql -U pst -d pst_analyser -tAc "select count(*) from managed_cases where name like 'ZZ-WAVE-%'"` prints `0`).

- [ ] **Step 5: Lint, types, commit**

Run: `npx biome format --write src/lib/case-utils.ts scripts/tests/db/case-utils.test.ts && npx biome check src/lib/case-utils.ts scripts/tests && npx tsc --noEmit`

```bash
git add src/lib/case-utils.ts scripts/tests/db/case-utils.test.ts
git commit -m "Scope case sibling lookups to the request wave" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Continue and wave-aware Run

**Files:**
- Modify: `src/lib/cases.ts` (`scanRequestSources`, add `continueRequest`, imports)
- Create: `src/app/api/requests/[requestId]/continue/route.ts`
- Create: `scripts/tests/db/waves.test.ts`

**Interfaces:**
- Consumes: `unionScope`, `waveRowId`, `removeOutputAbove` (Task 1); schema fields (Task 2).
- Produces:
  - `continueRequest(requestId: string, add: string): Promise<CaseRequest>` — requires `completed`; `wave += 1`, `wave_scope = add`, `scope = unionScope(scope, add)`, `render_base/warning_base = null`, status `ready`; creates missing input/output folders.
  - `scanRequestSources` replaces only the current wave's rows (and their emails), uses `waveRowId`, validates sources against `wave_scope` for wave > 1, and for wave > 1 removes leftover output above the stored bases and clears them.
  - HTTP: `POST /api/requests/{id}/continue` body `{ "add": "mail" | "files" | "both" }` → `200 { request }` or `400 { error }`.

- [ ] **Step 1: Write the failing database test**

Create `scripts/tests/db/waves.test.ts`:

```ts
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { continueRequest, scanRequestSources } from "../../../src/lib/cases";
import { prisma } from "../../../src/lib/prisma";

const tag = crypto.randomUUID().slice(0, 8);
const caseId = `t-case-${tag}`;
const requestId = `t-req-${tag}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "waves-db-"));
const staging = path.join(root, "Staging", "R1");
const deliverable = path.join(root, "Results", "R1");

describe("continue and wave-aware scan", () => {
  before(async () => {
    fs.mkdirSync(path.join(staging, "PST"), { recursive: true });
    fs.mkdirSync(path.join(deliverable, "Emails"), { recursive: true });
    fs.writeFileSync(path.join(staging, "PST", "Exchange.001.pst"), "w1");
    await prisma.managedCase.create({
      data: {
        id: caseId,
        name: `ZZ-WAVE-${tag}`,
        subject_name: "T",
        subject_email: "t@example.com",
      },
    });
    await prisma.caseRequest.create({
      data: {
        id: requestId,
        case_id: caseId,
        name: "R1",
        scope: "mail",
        status: "ready",
        staging_path: staging,
        deliverable_path: deliverable,
      },
    });
  });

  after(async () => {
    const files = await prisma.processedFile.findMany({
      where: { case_request_id: requestId },
      select: { id: true },
    });
    await prisma.email.deleteMany({
      where: { file_id: { in: files.map((f) => f.id) } },
    });
    await prisma.processedFile.deleteMany({
      where: { case_request_id: requestId },
    });
    await prisma.caseRequest.deleteMany({ where: { id: requestId } });
    await prisma.managedCase.deleteMany({ where: { id: caseId } });
    await prisma.$disconnect();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("wave 1 scan creates rows with wave 1", async () => {
    const { sources } = await scanRequestSources(requestId);
    assert.equal(sources.length, 1);
    const row = await prisma.processedFile.findUniqueOrThrow({
      where: { id: sources[0].id },
    });
    assert.equal(row.wave, 1);
    // Pretend the wave finished, with an email hash recorded for dedup memory.
    await prisma.email.create({
      data: { id: `t-email-${tag}`, file_id: row.id, email_hash: `t-hash-${tag}` },
    });
    await prisma.caseRequest.update({
      where: { id: requestId },
      data: { status: "completed" },
    });
  });

  it("continue refuses a request that is not completed", async () => {
    await prisma.caseRequest.update({
      where: { id: requestId },
      data: { status: "running" },
    });
    await assert.rejects(() => continueRequest(requestId, "mail"));
    await prisma.caseRequest.update({
      where: { id: requestId },
      data: { status: "completed" },
    });
  });

  it("continue bumps the wave once and a second call is refused", async () => {
    const next = await continueRequest(requestId, "files");
    assert.equal(next.wave, 2);
    assert.equal(next.wave_scope, "files");
    assert.equal(next.scope, "both");
    assert.equal(next.status, "ready");
    assert.equal(next.render_base, null);
    assert.ok(fs.existsSync(path.join(staging, "Files")));
    assert.ok(fs.existsSync(path.join(deliverable, "Documents")));
    await assert.rejects(() => continueRequest(requestId, "files"));
  });

  it("wave 2 scan keeps wave 1 rows and emails and requires only the wave's sources", async () => {
    // No Files content yet: the wave is files-only, so it must refuse.
    await assert.rejects(() => scanRequestSources(requestId));
    fs.writeFileSync(path.join(staging, "Files", "note.txt"), "w2");
    const { sources } = await scanRequestSources(requestId);
    assert.equal(sources.length, 1);
    assert.equal(sources[0].kind, "files");
    const rows = await prisma.processedFile.findMany({
      where: { case_request_id: requestId },
      orderBy: { wave: "asc" },
    });
    assert.deepEqual(rows.map((r) => r.wave), [1, 2]);
    assert.equal(
      await prisma.email.count({ where: { email_hash: `t-hash-${tag}` } }),
      1,
    );
  });

  it("re-running a failed wave 2 removes leftovers above the stored base", async () => {
    fs.writeFileSync(path.join(deliverable, "Emails", "Email 01.pdf"), "x");
    fs.writeFileSync(path.join(deliverable, "Emails", "Email 02.pdf"), "x");
    fs.writeFileSync(path.join(deliverable, "Emails", "Email 03.pdf"), "x");
    await prisma.caseRequest.update({
      where: { id: requestId },
      data: { status: "failed", render_base: 1, warning_base: 0 },
    });
    await scanRequestSources(requestId);
    assert.deepEqual(fs.readdirSync(path.join(deliverable, "Emails")).sort(), [
      "Email 01.pdf",
    ]);
    const request = await prisma.caseRequest.findUniqueOrThrow({
      where: { id: requestId },
    });
    assert.equal(request.render_base, null);
    assert.equal(request.warning_base, null);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
docker cp scripts/tests "$(docker compose ps -q app)":/workspace/scripts/tests
docker cp src "$(docker compose ps -q app)":/workspace/src
docker compose exec -T app npm run test:db
```

Expected: FAIL — `continueRequest` is not exported.

- [ ] **Step 3: Implement in `src/lib/cases.ts`**

Add imports at the top:

```ts
import { removeOutputAbove, unionScope, waveRowId } from "./request-waves";
```

Add `continueRequest` below `addManagedRequest`:

```ts
/**
 * Reopens a completed request for its next wave. New sources go into the same
 * staging folders and are delivered into the same output folder.
 */
export async function continueRequest(requestId: string, addRaw: string) {
  const add = assertScope(addRaw);
  const request = await prisma.caseRequest.findUnique({
    where: { id: requestId },
    include: { case: { select: { status: true } } },
  });
  if (!request || request.case.status !== "active") {
    throw new Error("Active request not found.");
  }
  if (request.status !== "completed") {
    throw new Error("Only a completed request can be continued.");
  }
  const folders = folderSet(add);
  await Promise.all([
    ...folders.inputs.map((name) =>
      fs.mkdir(path.join(request.staging_path, name), { recursive: true }),
    ),
    ...folders.outputs.map((name) =>
      fs.mkdir(path.join(request.deliverable_path, name), { recursive: true }),
    ),
  ]);
  // Guarded so a double click or a concurrent Run cannot bump the wave twice.
  const updated = await prisma.caseRequest.updateMany({
    where: { id: requestId, status: "completed" },
    data: {
      status: "ready",
      wave: { increment: 1 },
      wave_scope: add,
      scope: unionScope(request.scope, add),
      render_base: null,
      warning_base: null,
      error: null,
      completed_at: null,
    },
  });
  if (updated.count === 0) {
    throw new Error("The request changed state. Refresh and try again.");
  }
  return prisma.caseRequest.findUniqueOrThrow({ where: { id: requestId } });
}
```

In `scanRequestSources`:

1. Replace `const scope = assertScope(managedRequest.scope);` with:

```ts
  const wave = managedRequest.wave;
  // Wave 2+ validates only the sources this wave was opened for.
  const scope = assertScope(
    wave > 1 && managedRequest.wave_scope
      ? managedRequest.wave_scope
      : managedRequest.scope,
  );
```

2. Replace the PST source id (the `crypto.createHash("sha256").update(`${managedRequest.id}:${full}`)...slice(0, 24)` expression) with `waveRowId(managedRequest.id, wave, full)` and the Files source id expression with `waveRowId(managedRequest.id, wave, path.join(managedRequest.staging_path, "Files"))`.

3. Immediately before the final `await prisma.$transaction([` add:

```ts
  // A re-run of a failed wave 2+ starts from scratch: drop the output its
  // earlier attempt numbered above the stored base. Wave 1 keeps today's
  // resume-by-existing-PDF behaviour.
  if (wave > 1 && managedRequest.render_base !== null) {
    const emailsDir = path.join(managedRequest.deliverable_path, "Emails");
    removeOutputAbove(emailsDir, "Email", managedRequest.render_base);
    removeOutputAbove(
      path.join(emailsDir, "Warning"),
      "Warning",
      managedRequest.warning_base ?? 0,
    );
  }
  const previousIds = (
    await prisma.processedFile.findMany({
      where: { case_request_id: managedRequest.id, wave },
      select: { id: true },
    })
  ).map((row) => row.id);
```

4. In the transaction replace the first operation

```ts
    prisma.processedFile.deleteMany({
      where: { case_request_id: managedRequest.id },
    }),
```

with

```ts
    prisma.email.deleteMany({ where: { file_id: { in: previousIds } } }),
    prisma.processedFile.deleteMany({
      where: { case_request_id: managedRequest.id, wave },
    }),
```

5. In the `prisma.processedFile.create({ data: { ... } })` data object add `wave,` (after `case_request_id: managedRequest.id,`).

6. In the final `prisma.caseRequest.update` data add:

```ts
        ...(wave > 1 ? { render_base: null, warning_base: null } : {}),
```

Remove the now-unused `crypto` import only if Biome reports it unused (it is still used elsewhere in `cases.ts` for `randomUUID`, so it stays).

- [ ] **Step 4: Add the route**

Create `src/app/api/requests/[requestId]/continue/route.ts`:

```ts
import { NextResponse } from "next/server";
import { continueRequest } from "@/lib/cases";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ requestId: string }> },
) {
  try {
    const { requestId } = await context.params;
    const { add } = (await request.json()) as { add?: string };
    const updated = await continueRequest(requestId, add ?? "");
    return NextResponse.json({
      request: {
        ...updated,
        pst_size_bytes: Number(updated.pst_size_bytes),
        files_size_bytes: Number(updated.files_size_bytes),
        deliverable_size_bytes: Number(updated.deliverable_size_bytes),
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Unable to continue request.",
      },
      { status: 400 },
    );
  }
}
```

- [ ] **Step 5: Run to verify it passes**

```bash
docker cp src "$(docker compose ps -q app)":/workspace/src
docker cp scripts/tests "$(docker compose ps -q app)":/workspace/scripts/tests
docker compose exec -T app npm run test:db
```

Expected: PASS for `scripts/tests/db/waves.test.ts` and `case-utils.test.ts`; verify no leftovers: `docker compose exec -T postgres psql -U pst -d pst_analyser -tAc "select count(*) from managed_cases where name like 'ZZ-WAVE-%'"` prints `0`.

- [ ] **Step 6: Lint, types, commit**

Run: `npx biome format --write src/lib/cases.ts "src/app/api/requests/[requestId]/continue/route.ts" scripts/tests/db/waves.test.ts && npx biome check src/lib/cases.ts "src/app/api/requests/[requestId]/continue/route.ts" scripts/tests && npx tsc --noEmit`

```bash
git add src/lib/cases.ts "src/app/api/requests/[requestId]/continue/route.ts" scripts/tests/db/waves.test.ts
git commit -m "Add request continue and wave-aware Run" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Render numbering

**Files:**
- Create: `src/lib/render-numbering.ts`
- Modify: `src/lib/converter.ts` (the `convertToPdfBatch` render loop and Warning section)
- Create: `scripts/tests/db/render-numbering.test.ts`

**Interfaces:**
- Consumes: `highestNumber`, `numberWidth`, `formatNumber` (Task 1); `CaseRequest.wave/render_base/warning_base` (Task 2).
- Produces: `resolveRenderBases(requestId: string | null, emailsDir: string): Promise<{ email: number; warning: number }>` — returns the stored bases; on first use computes and persists them: wave 1 → 0/0 always (never scans); wave ≥ 2 → highest existing `Email N` in `emailsDir` and `Warning N` in `emailsDir/Warning`. `null` request id (legacy row) → 0/0 without database access.

- [ ] **Step 1: Write the failing database test**

Create `scripts/tests/db/render-numbering.test.ts`:

```ts
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { prisma } from "../../../src/lib/prisma";
import { resolveRenderBases } from "../../../src/lib/render-numbering";

const tag = crypto.randomUUID().slice(0, 8);
const caseId = `t-case-${tag}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "render-"));
const emails = path.join(root, "Emails");

async function makeRequest(id: string, wave: number) {
  await prisma.caseRequest.create({
    data: {
      id,
      case_id: caseId,
      name: id,
      scope: "mail",
      staging_path: path.join(root, "s", id),
      deliverable_path: path.join(root, "d", id),
      wave,
    },
  });
}

describe("resolveRenderBases", () => {
  const wave1 = `t-r1-${tag}`;
  const wave2 = `t-r2-${tag}`;
  before(async () => {
    fs.mkdirSync(path.join(emails, "Warning"), { recursive: true });
    for (const n of ["0001", "0002", "0003"]) {
      fs.writeFileSync(path.join(emails, `Email ${n}.pdf`), "x");
    }
    fs.writeFileSync(path.join(emails, "Warning", "Warning 02.pdf"), "x");
    await prisma.managedCase.create({
      data: {
        id: caseId,
        name: `ZZ-WAVE-${tag}`,
        subject_name: "T",
        subject_email: "t@example.com",
      },
    });
    await makeRequest(wave1, 1);
    await makeRequest(wave2, 2);
  });
  after(async () => {
    await prisma.caseRequest.deleteMany({ where: { case_id: caseId } });
    await prisma.managedCase.deleteMany({ where: { id: caseId } });
    await prisma.$disconnect();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns zero for a legacy row without a request", async () => {
    assert.deepEqual(await resolveRenderBases(null, emails), {
      email: 0,
      warning: 0,
    });
  });

  it("wave 1 never scans, even when partial PDFs already exist", async () => {
    assert.deepEqual(await resolveRenderBases(wave1, emails), {
      email: 0,
      warning: 0,
    });
  });

  it("wave 2 starts after the highest delivered number and persists it", async () => {
    assert.deepEqual(await resolveRenderBases(wave2, emails), {
      email: 3,
      warning: 2,
    });
    const stored = await prisma.caseRequest.findUniqueOrThrow({
      where: { id: wave2 },
    });
    assert.equal(stored.render_base, 3);
    assert.equal(stored.warning_base, 2);
  });

  it("a retry reuses the stored base even after more PDFs exist", async () => {
    fs.writeFileSync(path.join(emails, "Email 0004.pdf"), "x");
    fs.writeFileSync(path.join(emails, "Email 0005.pdf"), "x");
    assert.deepEqual(await resolveRenderBases(wave2, emails), {
      email: 3,
      warning: 2,
    });
  });

  it("an empty output folder yields zero for wave 2", async () => {
    const empty = `t-r3-${tag}`;
    await makeRequest(empty, 2);
    assert.deepEqual(
      await resolveRenderBases(empty, path.join(root, "nothing-here")),
      { email: 0, warning: 0 },
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
docker cp scripts/tests "$(docker compose ps -q app)":/workspace/scripts/tests
docker compose exec -T app npm run test:db -- 2>&1 | tail -20
```

Expected: FAIL — `Cannot find module '../../../src/lib/render-numbering'`.

- [ ] **Step 3: Implement `resolveRenderBases`**

Create `src/lib/render-numbering.ts`:

```ts
import fs from "node:fs";
import path from "node:path";
import { prisma } from "./prisma";
import { highestNumber } from "./request-waves";

function entries(directory: string): string[] {
  return fs.existsSync(directory) ? fs.readdirSync(directory) : [];
}

/**
 * Bases for this wave's `Email N` / `Warning N` numbering. Stored on the
 * request at the wave's first Render so a retry numbers identically. Wave 1
 * always starts at 0 (a retried wave-1 render may already hold its own partial
 * PDFs and must keep numbering from 1); wave 2+ continue after the highest
 * number already delivered.
 */
export async function resolveRenderBases(
  requestId: string | null,
  emailsDir: string,
): Promise<{ email: number; warning: number }> {
  if (!requestId) return { email: 0, warning: 0 };
  const request = await prisma.caseRequest.findUnique({
    where: { id: requestId },
    select: { wave: true, render_base: true, warning_base: true },
  });
  if (!request) return { email: 0, warning: 0 };

  const email =
    request.render_base ??
    (request.wave > 1 ? highestNumber(entries(emailsDir), "Email") : 0);
  const warning =
    request.warning_base ??
    (request.wave > 1
      ? highestNumber(entries(path.join(emailsDir, "Warning")), "Warning")
      : 0);

  if (request.render_base === null || request.warning_base === null) {
    await prisma.caseRequest.updateMany({
      where: {
        id: requestId,
        render_base: request.render_base,
        warning_base: request.warning_base,
      },
      data: { render_base: email, warning_base: warning },
    });
  }
  return { email, warning };
}
```

- [ ] **Step 4: Wire it into the converter**

In `src/lib/converter.ts` add imports:

```ts
import { resolveRenderBases } from "./render-numbering";
import { formatNumber, numberWidth } from "./request-waves";
```

Replace

```ts
    const padLength = String(Math.max(1, emlFiles.length)).length;
```

with

```ts
    const bases = await resolveRenderBases(
      row.case_request_id,
      deliverablesDir,
    );
    const padLength = numberWidth(
      fs.readdirSync(deliverablesDir),
      "Email",
      bases.email + emlFiles.length,
    );
```

Replace

```ts
      const baseName = `Email ${String(idx + 1).padStart(padLength, "0")}`;
```

with

```ts
      const baseName = `Email ${formatNumber(bases.email + idx + 1, padLength)}`;
```

In the Warning section: add a deterministic order to the query —

```ts
    const warningRecords = await prisma.email.findMany({
      where: {
        file_id: { in: caseIdsForWarning },
        ai_decision: "warning",
        is_duplicate: 0,
      },
      select: { email_hash: true },
      orderBy: { email_hash: "asc" },
    });
```

replace `const warnPad = String(Math.max(1, warningRecords.length)).length;` with

```ts
      const warnPad = numberWidth(
        fs.readdirSync(warningDir),
        "Warning",
        bases.warning + warningRecords.length,
      );
```

and `const baseName = `Warning ${String(wi + 1).padStart(warnPad, "0")}`;` with

```ts
        const baseName = `Warning ${formatNumber(bases.warning + wi + 1, warnPad)}`;
```

- [ ] **Step 5: Run to verify it passes**

```bash
docker cp src "$(docker compose ps -q app)":/workspace/src
docker cp scripts/tests "$(docker compose ps -q app)":/workspace/scripts/tests
docker compose exec -T app npm run test:db
```

Expected: PASS for all three DB test files; no `ZZ-WAVE-%` leftovers.

- [ ] **Step 6: Lint, types, commit**

Run: `npx biome format --write src/lib/render-numbering.ts src/lib/converter.ts scripts/tests/db/render-numbering.test.ts && npx biome check src/lib/render-numbering.ts src/lib/converter.ts scripts/tests && npx tsc --noEmit`

```bash
git add src/lib/render-numbering.ts src/lib/converter.ts scripts/tests/db/render-numbering.test.ts
git commit -m "Continue Email and Warning numbering across waves" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Reset and per-wave progress

**Files:**
- Modify: `src/app/api/requests/[requestId]/reset/route.ts`
- Modify: `src/app/api/cases/route.ts` (`GET`)

**Interfaces:**
- Consumes: `CaseRequest.wave/wave_scope/render_base/warning_base`, `ProcessedFile.wave`.
- Produces: Reset returns a request to wave 1 with cleared wave fields. `GET /api/cases` computes `phaseProgress`/`phaseTiming` from the **current wave's** rows only; each request object already carries `wave` and `wave_scope` (spread of the request columns).

- [ ] **Step 1: Reset starts over**

In the reset route's `prisma.caseRequest.update` `data`, add after `files_exported: 0,`:

```ts
          wave: 1,
          wave_scope: null,
          render_base: null,
          warning_base: null,
```

- [ ] **Step 2: Progress for the current wave only**

In `src/app/api/cases/route.ts`, add `wave: true,` to the `processed_files` `select`, and replace the `requests:` mapping so it filters:

```ts
      requests: item.requests.map(({ processed_files, ...request }) => {
        // Phase cards describe the wave that is running; earlier waves are
        // finished and only contribute to the cumulative header totals.
        const currentWave = processed_files.filter(
          (file) => file.wave === request.wave,
        );
        return {
          ...request,
          case_type: item.case_type,
          pst_size_bytes: Number(request.pst_size_bytes),
          files_size_bytes: Number(request.files_size_bytes),
          deliverable_size_bytes: Number(request.deliverable_size_bytes),
          phaseProgress: phaseProgress(currentWave),
          phaseTiming: phaseTiming(currentWave),
        };
      }),
```

- [ ] **Step 3: Lint and types**

Run: `npx biome check src/app/api/cases/route.ts "src/app/api/requests/[requestId]/reset/route.ts" && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Check against the running stack**

```bash
docker cp src "$(docker compose ps -q app)":/workspace/src
sleep 6
curl -s localhost:3000/api/cases | python3 -c 'import json,sys; d=json.load(sys.stdin); [print(c["name"], r["name"], "wave", r["wave"], r["status"], r["phaseProgress"]["upload"]) for c in d["cases"] for r in c["requests"]]'
```

Expected: each request prints `wave 1` and its existing status; MOW/R1M still shows upload `completed`. (Requires Task 2's migration applied in Task 4's step 2.)

- [ ] **Step 5: Commit**

```bash
git add src/app/api/cases/route.ts "src/app/api/requests/[requestId]/reset/route.ts"
git commit -m "Reset waves on request reset and show per-wave progress" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Dashboard — Wave badge, Continue, stronger Reset confirm

**Files:**
- Modify: `src/components/dashboard/CaseManager.tsx`

**Interfaces:**
- Consumes: `POST /api/requests/{id}/continue` (Task 5); `request.wave`, `request.wave_scope` from `GET /api/cases` (Task 7).

- [ ] **Step 1: Types and state**

In `type RequestItem` add after `scope: Scope;`:

```ts
  wave: number;
  wave_scope?: Scope | null;
```

Add state next to `newRequestFor`:

```ts
  const [continueTarget, setContinueTarget] = useState<RequestItem | null>(null);
  const [continueAdd, setContinueAdd] = useState<Scope>("mail");
```

Add the handler next to `addRequest`:

```ts
  const continueWave = async () => {
    if (!continueTarget) return;
    const result = await call(
      `continue-${continueTarget.id}`,
      `/api/requests/${continueTarget.id}/continue`,
      { method: "POST", body: JSON.stringify({ add: continueAdd }) },
    );
    if (result) setContinueTarget(null);
  };
```

- [ ] **Step 2: Wave badge and Continue button**

In the request header, after the scope badge `<span>…{request.scope}</span>` add:

```tsx
                                  {request.wave > 1 && (
                                    <span className="rounded-full border border-sky-400/20 bg-sky-500/15 px-2 py-1 text-xs font-semibold text-sky-200">
                                      Wave {request.wave}
                                    </span>
                                  )}
```

In the action button group (the `<div className="flex gap-2">` containing Run/Reset), before the Run button add:

```tsx
                                  {request.status === "completed" && (
                                    <Button
                                      type="button"
                                      variant="outline"
                                      size="sm"
                                      className="border-sky-400/45 bg-sky-500/10 text-sky-100 hover:bg-sky-500/20 hover:text-white"
                                      disabled={busy === `continue-${request.id}`}
                                      onClick={() => {
                                        setContinueAdd(
                                          request.scope === "files"
                                            ? "files"
                                            : "mail",
                                        );
                                        setContinueTarget(request);
                                      }}
                                    >
                                      <Plus /> Continue
                                    </Button>
                                  )}
```

- [ ] **Step 3: Stronger Reset confirmation past wave 1**

In the Reset button `onClick`, replace

```tsx
                                    onClick={() =>
                                      void call(
                                        `reset-${request.id}`,
                                        `/api/requests/${request.id}/reset`,
                                        { method: "POST" },
                                      )
                                    }
```

with

```tsx
                                    onClick={() => {
                                      if (
                                        request.wave > 1 &&
                                        !window.confirm(
                                          `Reset ${request.name}? This removes the output and email history of all ${request.wave} waves and cannot be re-created once earlier PSTs are deleted.`,
                                        )
                                      ) {
                                        return;
                                      }
                                      void call(
                                        `reset-${request.id}`,
                                        `/api/requests/${request.id}/reset`,
                                        { method: "POST" },
                                      );
                                    }}
```

- [ ] **Step 4: Continue dialog**

Add after the "Add request" `<Dialog>` block:

```tsx
      <Dialog
        open={!!continueTarget}
        onOpenChange={(open) => !open && setContinueTarget(null)}
      >
        <DialogContent className="border-slate-700 bg-slate-900 text-slate-100">
          <DialogHeader>
            <DialogTitle>
              Continue {continueTarget?.name} (wave {(continueTarget?.wave ?? 1) + 1})
            </DialogTitle>
            <DialogDescription>
              New sources go into the same staging folders and are delivered
              into the same output folder. Emails already delivered are skipped
              and numbering continues.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <fieldset>
              <legend className="mb-2 text-sm font-semibold text-slate-200">
                Add to this request
              </legend>
              <div className="grid grid-cols-3 gap-2">
                {scopeOptions.map((option) => {
                  const selected = continueAdd === option.value;
                  return (
                    <label
                      key={option.value}
                      className={
                        selected
                          ? "rounded-xl border border-sky-400/45 bg-sky-500/20 px-2 py-3 text-left text-sky-100"
                          : "rounded-xl border border-slate-700 bg-slate-950/55 px-2 py-3 text-left text-slate-400 transition hover:border-slate-600 hover:bg-slate-800 hover:text-slate-100"
                      }
                    >
                      <input
                        type="radio"
                        name="continue-scope"
                        value={option.value}
                        checked={selected}
                        onChange={() => setContinueAdd(option.value)}
                        className="sr-only"
                      />
                      <span className="block text-sm font-bold">
                        {option.label}
                      </span>
                      <span className="mt-1 block text-xs text-current opacity-70">
                        {option.description}
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
            <Button
              type="button"
              disabled={
                !continueTarget || busy === `continue-${continueTarget.id}`
              }
              onClick={() => void continueWave()}
            >
              {continueTarget && busy === `continue-${continueTarget.id}` && (
                <Loader2 className="animate-spin" />
              )}
              Continue
            </Button>
          </div>
        </DialogContent>
      </Dialog>
```

- [ ] **Step 5: Lint, types, build check**

Run: `npx biome format --write src/components/dashboard/CaseManager.tsx && npx biome check src/components/dashboard/CaseManager.tsx && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/dashboard/CaseManager.tsx
git commit -m "Add wave badge, Continue dialog and wave-aware Reset confirm" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Docs, deployment and verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the feature**

In `README.md`, after the "Staging & Output Layout" section add:

```markdown
## Running a request in waves

A completed request can be **continued** when a case is larger than the disk.
Use **Continue** on the request card, choose whether the next wave adds Mail,
Files or both, drop the new PSTs/Files into the same staging folders and Run.

- Output goes to the same `[case]/[request]` folder; `Email NNNN` numbering
  continues after the last delivered number.
- Emails already delivered by an earlier wave are skipped at Extract.
- You can delete a finished wave's PSTs to free space; AIDA keeps the email
  hashes it needs to deduplicate later waves.
- **Reset** starts the request over (all waves, hashes and output).
```

- [ ] **Step 2: Full local verification**

Run: `npm test && npx tsc --noEmit && npx biome check`
Expected: all unit tests pass, no type errors, Biome clean for the files changed in this plan.

- [ ] **Step 3: Rebuild so the image contains the code (ask the user first)**

Confirm no request is `queued`/`running`, then:

```bash
npm run docker:rebuild
docker compose up -d --force-recreate dispatcher
```

Expected: `app` healthy; `docker compose exec -T app npx prisma migrate status` reports the wave migration applied; `docker compose exec -T app npm run test:db` passes inside the rebuilt image.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "Document request waves" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: User-run smoke test (real readpst + OpenAI; not run by the agent)**

On a throwaway client or employee case with two tiny PSTs that share one email (the same Message-ID):

1. Create request `R1` (mail), put PST A in `PST/`, Run, wait for `completed`; note the highest `Emails/Email NNNN`.
2. Delete PST A from staging (Finder). Open the dashboard: the request must still be `completed` and show its counters.
3. **Continue** → Mail, put PST B (same filename allowed) in `PST/`, Run.
4. Expect: new PDFs start at the next number; the shared email is not delivered twice; the card shows `Wave 2` with progress for wave 2 only; header totals include wave 1.
5. **Reset** asks for a stronger confirmation and returns the card to wave 1.

---

## Self-Review (spec coverage)

- Data model (4 columns + `ProcessedFile.wave`): Task 2.
- Continue/Run lifecycle, scope union, row ids, failed-wave rerun cleanup, blocked states: Task 5 (blocking while `queued/running/stopping` is inherited — `continueRequest` requires `completed`; `scanRequestSources` already requires `ready|failed`).
- Dedup across waves and prune protection: Tasks 3 and 1 (dedup itself needs no code).
- Coordinator/settled scoping: Task 4.
- Numbering and Warning numbering, retry stability, wave-1 invariance: Task 6 (+ helpers in Task 1).
- Reset semantics, per-wave progress, UI: Tasks 7 and 8.
- Verification and smoke test: Task 9 and the per-task tests.
- Type consistency: helper names (`unionScope`, `waveRowId`, `highestNumber`, `numberWidth`, `formatNumber`, `rowsToPrune`, `removeOutputAbove`, `resolveRenderBases`, `continueRequest`) are identical across tasks.
