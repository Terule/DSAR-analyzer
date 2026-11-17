<!-- BEGIN:nextjs-agent-rules -->
# Coding Agent Guidelines — PST Analyser

This is **Next.js 16.2.7** running on **Node.js**. Many APIs differ from what your training data expects. Read `node_modules/next/dist/docs/` before writing any Next.js code. Heed deprecation notices.

---

## Runtime & Tooling

- **Runtime**: Node.js with npm. Use `npm` scripts for install/build/dev tasks.
- **Database**: PostgreSQL 16 (via docker-compose, local: `postgres://pst:pst@localhost:5432/pst_analyser`), accessed exclusively through **Prisma 7.8.0** (`src/lib/prisma.ts` singleton client + driver adapter `@prisma/adapter-pg`). Schema lives in `prisma/schema.prisma`; connection config is in `prisma.config.ts` (not `datasource url`). `node:sqlite` and `better-sqlite3` have been fully removed — do not reintroduce them.
  - Use Prisma's native query methods (`findUnique`, `findMany`, `create`, `update`, `updateMany`, `upsert`, `delete`, `deleteMany`, `count`, `aggregate`, etc.) — never raw SQL (`$queryRaw`/`$executeRaw`).
  - Wrap any multi-statement atomic operation in `prisma.$transaction([...])` (array form for independent parallel writes) or `prisma.$transaction(async (tx) => {...})` (callback form for read-then-write sequences).
  - Use `updateMany({ where: { ..., status: "pending" } })` + check `result.count` for atomic "claim a pending row" patterns instead of update-then-re-select.
- **Bundler**: Turbopack is the Next.js default but this project opts out — `next dev --webpack` and `next build --webpack` are used explicitly (see `package.json`).
- **Linter/Formatter**: Biome (`biome check`, `biome format --write`). No ESLint. No Prettier.

---

## Next.js 16 Breaking Changes

### `params` and `searchParams` are now Promises

```ts
// WRONG (old pattern)
export default function Page({ params }: { params: { slug: string } }) { ... }

// CORRECT
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
}
```

Same applies to `searchParams` in page components.

### Route Handlers

- Defined in `app/api/<name>/route.ts` — no `pages/api/` directory.
- Use native `Request` / `Response` or `NextRequest` / `NextResponse`.
- `GET` handlers are **not** cached by default. Use `export const dynamic = 'force-static'` to opt in.

### Server vs Client Components

- All layouts and pages are **Server Components by default**.
- Add `'use client'` only when you need state, event handlers, lifecycle hooks, or browser APIs.
- Do not add `'use client'` to files that only fetch data or render static markup.

### Caching

- Use the `'use cache'` directive (not `fetch` cache options) for caching in this version.
- For instant client-side navigations, export `unstable_instant` from the route — Suspense alone is not enough. See `node_modules/next/dist/docs/01-app/02-guides/instant-navigation.mdx`.

---

## Project Conventions

- **Database**: PostgreSQL 16 via Prisma (see Runtime & Tooling above). Multiple processes (API routes + detached workers) write concurrently — Postgres MVCC + Prisma transactions handle this; there is no `busy_timeout`/retry helper needed anymore (`withSqliteBusyRetry` has been removed).
- **AI**: provider chosen by the `ai_provider` setting. OpenAI Batch API (`gpt-6-luna`, reasoning off) via `src/lib/ai.ts` stays supported. Amazon Bedrock (region `eu-central-1`, `eu.` inference profiles only; `us.`/`global.` are forbidden for DSAR data): Batch (Claude Haiku 4.5, S3 + service role) for more than 100 items, synchronous Converse (Claude Haiku 5.5) for 100 or fewer, and Haiku 5.5 re-reviews the items Haiku 4.5 discarded. Never use Sonnet. Credentials only from the AWS chain (`~/.aws` mounted read-only at `/run/aws`, or environment variables), never in Settings, the database or git. Record ids and job names are opaque (no personal data). Streaming/realtime is still not used, but synchronous Converse is allowed.
- **Case is the unit for AI & Render**: even with multiple PST files in a request, the AI audit and PDF render each run **once per case** over the shared `.unique-emails` folder. A deterministic *coordinator* row (smallest id among the case's `kind='pst'` rows) holds the live batch state (`batch_id`, `ai_status`, `ai_batches_total/done`, aggregate AI counts); terminal status is mirrored to every case row via `markCaseAiCompleted` / `markCaseAiFailed` in `src/lib/case-utils.ts`. Update the `emails` table by `email_hash` alone (globally unique + request-scoped) — do not add a `file_id` filter to AI-stage email writes. Render is gated by `isCaseAiSettled` and `convert-worker.pickNext` so it never runs while a sibling PST is mid-AI.
- **Deduplication is per request/case**: `email_hash = sha256("[case]/[request]/PST" :: messageId-or-fallback)` (see `analyzer.ts`). The same email across PST files of one request dedups; different requests never collide. Subject-**independent** exclusions (dedup, privileged keyword, drafts) run at extraction; subject-**dependent** ones (subject-not-mentioned, GPT audit) run at the AI phase so a case can be re-audited with a new subject without re-extracting.
- **Exclusion keywords are centralized** in `src/lib/exclusions.ts` (`PRIVILEGED_KEYWORDS` + `PRIVILEGED_KEYWORDS_RE`). Do not redefine the list/regex inline in `analyzer.ts`, `ai.ts`, or `standalone-processor.ts`.
- **AI batch polling**: In-server self-stopping poller in `src/lib/batch-scheduler.ts` (`ensureBatchPollerRunning` / `runBatchSweep` / `stopBatchPoller`). Started from `/api/filter` when the AI phase begins; resumed from `/api/events` after a restart; reclaims render jobs orphaned by a dead worker. There is **no standalone cron process** — do not reintroduce one. `/api/cron` is only a thin manual trigger that delegates to `runBatchSweep`.
- **PDF**: WeasyPrint-based pipeline in `src/lib/converter.ts`. Do not reintroduce Puppeteer. It reads `selected/` from the hidden working path (`[case]/[request]/.work/PST/.unique-emails`) and writes `Emails/` to the deliverable path (`[case]/[request]/Emails`) — keep that split.
- **Email extraction**: `readpst` (libpst) + `mailparser`. All EML logic lives in `src/lib/analyzer.ts` and `src/lib/exporter.ts`.
- **Files phase**: Teams messages + loose documents live in a `Files` folder and are processed by `src/lib/standalone-processor.ts` (relevance filter + content dedup + WeasyPrint). It runs **after** the Render phase, never in parallel.
- **Background workers**: worker entry points live under `scripts/workers/`. Detached legacy workers must be cleaned up on wipe/reset (`/api/wipe` kills matching `scripts/workers/files-worker.ts` processes). Their stdout/stderr is piped to `logs/<name>.log` via `openWorkerLogFd` — never spawn them with `stdio: 'ignore'`. Synchronous CPU-heavy parsing (DOCX/XLSX) must go through `scripts/workers/office-worker.ts` so `withTimeout` can actually interrupt it.
- **Confidentiality screening (every case type, employee and client)**: the AI never delivers confidential content. A verdict is `keep | discard | review`, decided by `decideFilesAi` (`src/lib/files-ai-prompt.ts`) from relevance, sensitivity category (`SENSITIVITY_CATEGORIES`: payroll, legal privilege, HR investigation, third-party personal data, other), large-file flag, subject involvement and mode (`employee | client | mail`). Rules: confidential → discard in every mode (client: always), except a document that is the subject's own (written to them, sent by them or made on their behalf, e.g. a retainer or claim letter), which is kept (payroll and compensation data is never kept, even the subject's own payslip); court orders, ring orders and internal legal analysis never sent to the subject are discarded. Confidentiality applies to files that are not ABOUT the subject: HR records (performance reviews, feedback, disciplinary, investigations) about the subject are kept, about other people discarded; other people's names inside a subject's file are kept (redacted later by HR review); AI failure/no text/unsettled → `review`; large file (> `FILES_AI_LARGE_FILE_PAGES` pages, default 30) is judged from a sample — relevant → `review`, confidential/irrelevant → discard. Password-protected files of any type are detected by signature (`src/lib/password-protection.ts`: OLE/CFB, ZIP, RAR4/5, 7z) and discarded in every case type, including the unconverted fallback and encrypted archives (`archive-expander.ts`). Never reintroduce a per-type regex check.
- **Files AI gate**: between the Files batches and finalize, `settleFilesBatches` (dispatcher) runs `advanceFilesAi` (`src/lib/files-ai-gate.ts`): a `filesAiPrepare` job reads this wave's converted PDFs (hash-named, i.e. unfinalized) and submits OpenAI Batch runs (`src/lib/files-ai.ts`, tables `files_ai_verdicts` / `files_ai_batch_runs`); the dispatcher's `runBatchSweep` polls them (`files-ai-poll.ts`); a `filesAiApply` job then moves `discard` files to `<request>/Discarded/` (never numbered or uploaded), `review` files to `<request>/For Human Review/` (plus `review.csv`), rewrites `Discarded/verdicts.csv`, and shifts counters (discard → skipped; review leaves counters unchanged). Runs for every case with a `case_request_id`, client included. No OpenAI client → all candidates go to review. A Files retry clears verdicts/runs/discards/reviews (`clearFilesAiState`). Toggle `files_ai_enabled` in System settings governs all screening. Size a run first with `scripts/maintenance/files-ai-rehearsal.ts` (read-only). Not yet screened: originals in `Unconverted/` and non-PDF client raw copies.
- **Mail screening (before Render)**: `src/lib/mail-screen.ts`. After the email audit (or directly, when the case skips it — client cases and no-batch paths) `startMailScreen` submits email bodies (client cases; employee bodies are judged in the audit itself via `sensitivity`) and every distinct attachment (content-hash keyed, flattened by `email-attachments.ts`) as `mail:<hash>` / `mail:body:<emailHash>` items in the same `files_ai_verdicts` / `files_ai_batch_runs` tables. The coordinator stays `ai_status="batch_ready"` with `mail_screen_status="screening"` until `settleMailScreens` (called from `batch-scheduler.ts`) releases Render. Render (`converter.ts`, `renderEmailAttachments`) only reads verdicts: keep → delivered, discard → dropped, review/never screened → `<request>/For Human Review/Emails/`. Nested EML/MSG are their own email rows, so the rules apply at every level. Email-body AI failure in employee cases stays a discard ("when in doubt, discard"); in client cases and for attachments it goes to review.
- **For Human Review/ is part of the delivery**: employee cases upload it to SharePoint (the HR review) via `listHumanReviewDeliverables` (Render sweep and Files finalize). Client cases never upload; the folder stays on disk for a person outside this pipeline. There is no review UI/state in the app by design.
- **Pipeline phases**: Parse → Extract → AI → Render → Files. Rows carry a `kind` of `'pst'` or `'files'`; email phases apply only to `kind='pst'` rows.
- **Staging/output layout**: input `STAGING_PATH/[case]/[request]/{PST,Files}`; output `EXTRACTED_PATH/[case]/[request]/{Emails,Messages,Documents}`. Row id is a hash of the full path, so moving a file orphans its row — `syncStagingArea` prunes rows whose backing file/folder no longer exists.
- **Environment variables**: `OPENAI_API_KEY`, `POSTGRES_URL`, `STAGING_PATH`, `EXTRACTED_PATH` — always read from `process.env`, never hardcode paths.
- **No hardcoded absolute paths** in committed code.

---

## Codex Handoff Snapshot

- Domain data path must remain Prisma-native only (`processed_files`, `emails`, `run_history`, `case_history`).
- Queue default name uses hyphenated form: `pst-analyser-orchestrator`.
- Control-plane internals may use `pg` SQL primitives where needed for lease semantics (`FOR UPDATE SKIP LOCKED`).
<!-- END:nextjs-agent-rules -->
