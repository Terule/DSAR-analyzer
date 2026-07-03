<!-- BEGIN:nextjs-agent-rules -->
# Coding Agent Guidelines — PST Analyser

This is **Next.js 16.2.7** running on **Bun**. Many APIs differ from what your training data expects. Read `node_modules/next/dist/docs/` before writing any Next.js code. Heed deprecation notices.

---

## Runtime & Tooling

- **Runtime**: Bun (not Node). Use `bun` for scripts, installs, and the SQLite driver (`bun:sqlite`).
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

- **Database**: Bun SQLite (`bun:sqlite`) at the path set by `DATABASE_PATH` env var. Runs in WAL mode with a `busy_timeout` (see `src/lib/db.ts`) because multiple processes (API routes + detached workers) write concurrently. Wrap hot analyzer writes in the `withSqliteBusyRetry` helper.
- **AI**: OpenAI Batch API (`gpt-4o-mini`) via `src/lib/ai.ts`. Do not switch to streaming/realtime calls.
- **AI batch polling**: In-server self-stopping poller in `src/lib/batch-scheduler.ts` (`ensureBatchPollerRunning` / `runBatchSweep` / `stopBatchPoller`). Started from `/api/filter` when the AI phase begins; resumed from `/api/events` after a restart. There is **no standalone cron process** — do not reintroduce one. `/api/cron` is only a thin manual trigger that delegates to `runBatchSweep`.
- **PDF**: WeasyPrint-based pipeline in `src/lib/converter.ts`. Do not reintroduce Puppeteer.
- **Email extraction**: `readpst` (libpst) + `mailparser`. All EML logic lives in `src/lib/analyzer.ts` and `src/lib/exporter.ts`.
- **Files phase**: Teams messages + loose documents live in a `Files` folder and are processed by `src/lib/standalone-processor.ts` (relevance filter + content dedup + WeasyPrint). It runs **after** the Render phase, never in parallel.
- **Background workers**: `convert-worker.ts`, `files-worker.ts`, `office-worker.ts` at the repo root run under Bun. They are spawned as **detached, unref'd** child processes and must be cleaned up on wipe/reset (`/api/wipe` kills matching `files-worker.ts` processes). Synchronous CPU-heavy parsing (DOCX/XLSX) must go through `office-worker.ts` so `withTimeout` can actually interrupt it.
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
  lib/           # Business logic (no React); includes batch-scheduler.ts, standalone-processor.ts
convert-worker.ts   # Detached PDF render worker (Render phase)
files-worker.ts     # Detached Files-phase worker (spawned by /api/files-process)
office-worker.ts    # Worker thread isolating sync DOCX/XLSX parsing
batches/            # Ephemeral JSONL files for OpenAI batch uploads (gitignored)
```
<!-- END:nextjs-agent-rules -->
