# AIDA — Automated Intelligent Data Auditor

A Next.js web application for performing **Data Subject Access Request (DSAR)** compliance audits on PST archives, Teams message exports, and loose document sets.

It ingests `.pst` files (and a per-request `Files` folder of Teams messages/documents), extracts and deduplicates content, runs an AI-powered relevance filter against a named data subject, and produces PDF exports of the kept material.

---

## How It Works

Work is organised per **case/request**, and the case is the unit of processing. A single request can contain one or more `.pst` files and an optional `Files` folder. The pipeline runs in phases, each tracked in a PostgreSQL database (via Prisma) and streamed live to the UI:

1. **Parse** — `readpst` extracts emails as `.eml` files (per PST). Each email is parsed, hashed, and **deduplicated across the whole request** (by `message-id` with a content-hash fallback; the hash is scoped to `[case]/[request]`, so the same email in two PST files is kept once for the case but never bleeds into a different case).
2. **Extract** — Unique emails are normalised into per-email JSON payloads for the AI, and drafts / headerless items are filtered out.
3. **AI Triage** — Runs **once per case** over all of its PST files' unique emails, in batches to the OpenAI Batch API (`gpt-4o-mini`). Cheap rule/system pre-filters run first (privileged-subject keyword, "subject not mentioned anywhere") to avoid API calls; the model then applies hard DSAR rules and returns `keep` / `discard`, followed by a strong-signal override and an attachments-only second pass.
4. **Render** — Runs **once per case**. Kept emails and their attachments (DOCX, XLSX, PDF) are rendered to PDF via WeasyPrint and written to the request's `Emails` output folder.
5. **Files** — Runs **after** Render. The `Files` folder (Teams messages + loose documents) is processed by a background worker: relevance-filtered against the subject, content-deduplicated, and rendered to the `Messages` / `Documents` output folders.

> **Case-level AI & Render:** even when a request has several PST files, the AI audit and PDF render each run a single time over the case's shared working folder. A deterministic *coordinator* row holds the live batch state and its status is mirrored to the other PST rows on completion.

### Exclusion / discard order (PST pipeline)

Deduplicate → privileged-subject keyword → draft (missing routing headers) → subject-not-mentioned-anywhere → oversized-payload → GPT `keep`/`discard` → weak-signal override → attachments second-pass rescue. The privileged/confidential keyword list lives in one place (`src/lib/exclusions.ts`) and is shared by both pipelines.

### AI batch polling

OpenAI batches complete asynchronously. Instead of a separate cron process, an **in-server self-managing poller** (`src/lib/batch-scheduler.ts`) starts automatically when the AI phase begins and **stops itself** once no AI/render work remains. If the server restarts mid-audit, the poller resumes as soon as the dashboard reconnects, and a render orphaned by a dead worker is reclaimed. The `/api/cron` route remains available only as an optional manual trigger.

---

## Prerequisites

- [Node.js](https://nodejs.org) (runtime, npm package manager)
- `readpst` (from `libpst`) — must be on `$PATH`
- WeasyPrint — must be installed for PDF generation
- An OpenAI API key

---

## Environment Variables

Create a `.env.local` file in the project root:

```env
OPENAI_API_KEY=sk-...
POSTGRES_URL=postgres://pst:pst@localhost:5432/pst_analyser
STAGING_PATH=/path/to/staging-area
EXTRACTED_PATH=/path/to/extracted_emails
```

---

## Staging & Output Layout

Input (under `STAGING_PATH`):

```
[case]/[request]/PST/*.pst      # email archives
[case]/[request]/Files/         # Teams messages + loose documents (optional)
```

Output (under `EXTRACTED_PATH`):

```
[case]/[request]/Emails/        # rendered PDFs from the PST pipeline
[case]/[request]/Messages/      # rendered Teams messages (Files phase)
[case]/[request]/Documents/     # rendered loose documents (Files phase)
```

The scanner indexes each `.pst` as a `kind='pst'` row and each `Files` folder as a single `kind='files'` row. Rows whose backing file/folder no longer exists on disk are pruned automatically on each scan.

---

## Getting Started

Install dependencies:

```bash
npm install
```

Run the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to access the UI. Batch polling and background workers are managed automatically by the app — no separate cron process is required.

---

## Docker (Primary Runtime)

This repository includes a Docker-first runtime for daily use:

- `Dockerfile` with native dependencies (`readpst`, `weasyprint`, `unzip`)
- `docker-compose.yml` with `app`, `postgres`, and `redis` services
- Shared volume mounts for staging/extracted/logs/batches
- Startup path checks (`scripts/docker-check.mjs`) to fail fast on bad mounts
- Health checks for app, Postgres, and Redis

### One-Time Setup

1. Copy `.env.docker.example` to `.env`.
2. Set absolute host paths for:
  - `HOST_STAGING_PATH`
  - `HOST_EXTRACTED_PATH`
3. Set `OPENAI_API_KEY`.

Important:

- Keep `STAGING_PATH` and `EXTRACTED_PATH` as container paths (`/data/...`) when running with Docker.
- Use `HOST_*` values to point to your real host folders.

### Run with Docker Compose

```bash
npm run docker:up
```

Run `npm run docker:up` (or `npm run docker:rebuild` after code changes).
The command prints AIDA's actual host URL after Compose starts, including when
Docker assigns a random host port.

Useful commands:

```bash
npm run docker:ps
npm run docker:logs
npm run docker:rebuild
npm run docker:down
```

### Notes

- The dispatcher is the production local execution path; phase work runs in short-lived Docker containers.
- `POSTGRES_URL` and `REDIS_URL` are required by the dispatcher.
- Docker compose uses `POSTGRES_URL_DOCKER` and `REDIS_URL_DOCKER` (defaulting to internal service DNS names) so containers do not try to connect to `localhost`.
- The control plane is enabled when Postgres configuration is present; set `CONTROL_PLANE_PIPELINE_ENABLED=true` to make this explicit.
- Host mount paths can be overridden via:
  - `HOST_STAGING_PATH`
  - `HOST_EXTRACTED_PATH`
  - `HOST_DATABASES_PATH`

### Local Control-Plane Worker

The Phase 3 pipeline is local-first. API case-start requests persist jobs in
the Postgres control-plane. The private Compose `dispatcher` claims those jobs
with Postgres leases and launches a short-lived, `--rm` Docker worker container
for each one. Redis (BullMQ) is the wake-up transport; Postgres is the durable
source of truth. The dispatcher is the only service with Docker-socket access.

Only one case is admitted to the local pipeline at a time. Jobs for that case
can still run in parallel within their phase limits; jobs from every other case
remain queued until the active case has fully settled (including OpenAI Batch
waiting).

Parse and Extract fan out per PST, AI is globally serialized while OpenAI Batch
work is pending, and Render/Files run in bounded parallelism across cases.

Set `CONTROL_PLANE_PIPELINE_ENABLED=true` to require this path explicitly. If
unset, it activates whenever `POSTGRES_URL` (or `POSTGRES_URL_DOCKER`) is
configured. You can also start the local consumer manually with:

```bash
npm run orchestrator:worker
```

### Phase 2 Scaffold Endpoints

Without Postgres control-plane config, these routes are safe no-ops for production runs.

- `GET /api/orchestrator/health`: reports control-plane + queue adapter health.
- `POST /api/orchestrator/bootstrap`: creates/updates Postgres control-plane tables.

These routes operate against the same durable job store used by the dispatcher.

### Migrating Existing Local Data To Docker

If you had local runs before Docker, point Docker to those same host folders via `HOST_*` paths first.

If a case was reset or failed and you want to re-run only AI next time (without wiping parse/extract), use:

```bash
npm run reset:ai:case -- --case <CASE> --request <REQUEST>
```

Example:

```bash
npm run reset:ai:case -- --case FH --request 2026
```

---

## Project Structure

```
src/
  app/
    api/           # Route handlers (analyze, filter, cron, events, files-process, wipe, ...)
    page.tsx       # Dashboard: per-case orchestration + SSE state
  components/      # React UI components (dashboard cards, phase indicators, metrics)
  hooks/           # useFileStream (SSE), useNotification
  lib/
    ai.ts                  # OpenAI batch file generation (case-level)
    analyzer.ts            # PST extraction and per-request email deduplication
    batch-worker.ts        # Batch result polling and DB updates
    batch-scheduler.ts     # In-server self-stopping AI batch poller
    case-utils.ts          # Case grouping + case-level AI/render status helpers
    exclusions.ts          # Shared privileged/confidential keyword filter
    standalone-processor.ts# Files phase engine (Teams messages + documents)
    converter.ts           # WeasyPrint-based PDF conversion
    prisma.ts               # Prisma client singleton (Postgres, via @prisma/adapter-pg)
    exporter.ts            # Email parsing and content extraction
    purger.ts              # Cleanup utilities
    staging.ts             # Staging scanner + stale-row pruning
    types.ts               # Shared TypeScript types

# Runtime and maintenance scripts
scripts/orchestrator/dispatcher.ts  # Persistent Docker job dispatcher
scripts/orchestrator/job-runner.ts  # One-shot phase-job entry point
scripts/workers/office-worker.ts    # Isolates synchronous DOCX/XLSX parsing
scripts/maintenance/                # Explicit one-off maintenance utilities
batches/            # Ephemeral JSONL files for OpenAI batch uploads (gitignored)
```

---

## Tech Stack

- **Next.js 16** (App Router, `--webpack`)
- **Node.js** — runtime
- **PostgreSQL 16** via **Prisma 7** — database access (see `prisma/schema.prisma`, `prisma.config.ts`)
- **OpenAI Batch API** — async AI triage at scale
- **WeasyPrint** — HTML-to-PDF rendering
- **Tailwind CSS v4**
- **Biome** — linting and formatting
