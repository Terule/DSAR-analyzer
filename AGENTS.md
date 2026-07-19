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
- **Styles**: Tailwind CSS v4 via PostCSS.

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
- **AI**: OpenAI Batch API (`gpt-4o-mini`) via `src/lib/ai.ts`. Do not switch to streaming/realtime calls.
- **Case is the unit for AI & Render**: even with multiple PST files in a request, the AI audit and PDF render each run **once per case** over the shared `.unique-emails` folder. A deterministic *coordinator* row (smallest id among the case's `kind='pst'` rows) holds the live batch state (`batch_id`, `ai_status`, `ai_batches_total/done`, aggregate AI counts); terminal status is mirrored to every case row via `markCaseAiCompleted` / `markCaseAiFailed` in `src/lib/case-utils.ts`. Update the `emails` table by `email_hash` alone (globally unique + request-scoped) — do not add a `file_id` filter to AI-stage email writes. Render is gated by `isCaseAiSettled` and `convert-worker.pickNext` so it never runs while a sibling PST is mid-AI.
- **Deduplication is per request/case**: `email_hash = sha256("[case]/[request]/PST" :: messageId-or-fallback)` (see `analyzer.ts`). The same email across PST files of one request dedups; different requests never collide. Subject-**independent** exclusions (dedup, privileged keyword, drafts) run at extraction; subject-**dependent** ones (subject-not-mentioned, GPT audit) run at the AI phase so a case can be re-audited with a new subject without re-extracting.
- **Exclusion keywords are centralized** in `src/lib/exclusions.ts` (`PRIVILEGED_KEYWORDS` + `PRIVILEGED_KEYWORDS_RE`). Do not redefine the list/regex inline in `analyzer.ts`, `ai.ts`, or `standalone-processor.ts`.
- **AI batch polling**: In-server self-stopping poller in `src/lib/batch-scheduler.ts` (`ensureBatchPollerRunning` / `runBatchSweep` / `stopBatchPoller`). Started from `/api/filter` when the AI phase begins; resumed from `/api/events` after a restart; reclaims render jobs orphaned by a dead worker. There is **no standalone cron process** — do not reintroduce one. `/api/cron` is only a thin manual trigger that delegates to `runBatchSweep`.
- **PDF**: WeasyPrint-based pipeline in `src/lib/converter.ts`. Do not reintroduce Puppeteer. It reads `selected/` from the hidden working path (`[case]/[request]/.work/PST/.unique-emails`) and writes `Emails/` to the deliverable path (`[case]/[request]/Emails`) — keep that split.
- **Email extraction**: `readpst` (libpst) + `mailparser`. All EML logic lives in `src/lib/analyzer.ts` and `src/lib/exporter.ts`.
- **Files phase**: Teams messages + loose documents live in a `Files` folder and are processed by `src/lib/standalone-processor.ts` (relevance filter + content dedup + WeasyPrint). It runs **after** the Render phase, never in parallel.
- **Background workers**: worker entry points live under `scripts/workers/`. Detached legacy workers must be cleaned up on wipe/reset (`/api/wipe` kills matching `scripts/workers/files-worker.ts` processes). Their stdout/stderr is piped to `logs/<name>.log` via `openWorkerLogFd` — never spawn them with `stdio: 'ignore'`. Synchronous CPU-heavy parsing (DOCX/XLSX) must go through `scripts/workers/office-worker.ts` so `withTimeout` can actually interrupt it.
- **Pipeline phases**: Parse → Extract → AI → Render → Files. Rows carry a `kind` of `'pst'` or `'files'`; email phases apply only to `kind='pst'` rows.
- **Staging/output layout**: input `STAGING_PATH/[case]/[request]/{PST,Files}`; output `EXTRACTED_PATH/[case]/[request]/{Emails,Messages,Documents}`. Row id is a hash of the full path, so moving a file orphans its row — `syncStagingArea` prunes rows whose backing file/folder no longer exists.
- **Environment variables**: `OPENAI_API_KEY`, `DATABASE_PATH`, `STAGING_PATH`, `EXTRACTED_PATH` — always read from `process.env`, never hardcode paths.
- **No hardcoded absolute paths** in committed code.

---

## File Structure

```
src/
  app/           # App Router: pages, layouts, API route handlers
  components/    # React client/server components
  hooks/         # SSE + notification hooks
  lib/           # Business logic (no React); batch-scheduler.ts, case-utils.ts,
                 # exclusions.ts, standalone-processor.ts, worker-log.ts, …
scripts/
  orchestrator/     # Dispatcher + one-shot phase runner
  workers/          # Node worker entry points
  maintenance/      # Explicit maintenance utilities
logs/               # Detached-worker stdout/stderr (gitignored)
batches/            # Ephemeral JSONL files for OpenAI batch uploads (gitignored)
```

---

## Codex Handoff Snapshot

- SQLite runtime path has been fully removed. `src/lib/db.ts` and `src/lib/history-db.ts` are deleted.
- Domain data path must remain Prisma-native only (`processed_files`, `emails`, `run_history`, `case_history`).
- Control-plane scaffold is present and compile-clean:
  - `src/lib/control-plane/postgres.ts`
  - `src/lib/control-plane/schema.ts`
  - `src/lib/control-plane/job-store.ts`
  - `src/lib/control-plane/types.ts`
  - `src/lib/queue/factory.ts`
  - `src/lib/queue/bullmq-adapter.ts`
  - `src/lib/queue/sqs-adapter.ts` (placeholder)
  - `src/app/api/orchestrator/health/route.ts`
  - `src/app/api/orchestrator/bootstrap/route.ts`
  - `src/app/api/orchestrator/sweep/route.ts`
- Queue default name uses hyphenated form: `pst-analyser-orchestrator`.
- Next implementation target: wire producer/consumer flow so phase transitions enqueue and process control-plane jobs while preserving current external API behavior.
- Control-plane internals may use `pg` SQL primitives where needed for lease semantics (`FOR UPDATE SKIP LOCKED`).
<!-- END:nextjs-agent-rules -->
