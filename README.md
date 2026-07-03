# PST Analyser

A Next.js web application for performing **Data Subject Access Request (DSAR)** compliance audits on PST archives, Teams message exports, and loose document sets.

It ingests `.pst` files (and a per-request `Files` folder of Teams messages/documents), extracts and deduplicates content, runs an AI-powered relevance filter against a named data subject, and produces PDF exports of the kept material.

---

## How It Works

Work is organised per **case/request**. A single request can contain one or more `.pst` files and an optional `Files` folder. The pipeline runs in phases, each tracked in a SQLite database and streamed live to the UI:

1. **Parse** — `readpst` extracts emails as `.eml` files. Each email is parsed, hashed, and deduplicated (by `message-id` with a content-hash fallback). Attachments are inventoried.
2. **Extract** — Unique emails are normalised into per-email JSON payloads for the AI, and drafts / headerless items are filtered out.
3. **AI Triage** — Emails are sent in batches to the OpenAI Batch API (`gpt-4o-mini`). The model applies hard DSAR rules (exact email match, name/alias signals, privileged-subject discards) and returns `keep` / `discard`. Rule/system pre-filters run before the model to avoid unnecessary calls.
4. **Render** — Kept emails and their attachments (DOCX, XLSX, PDF) are rendered to PDF via WeasyPrint and written to the request's `Emails` output folder.
5. **Files** — Runs **after** Render. The `Files` folder (Teams messages + loose documents) is processed by a background worker: relevance-filtered against the subject, content-deduplicated, and rendered to the `Messages` / `Documents` output folders.

### AI batch polling

OpenAI batches complete asynchronously. Instead of a separate cron process, an **in-server self-managing poller** (`src/lib/batch-scheduler.ts`) starts automatically when the AI phase begins and **stops itself** once no AI/render work remains. If the server restarts mid-audit, the poller resumes as soon as the dashboard reconnects. The `/api/cron` route remains available only as an optional manual trigger.

---

## Prerequisites

- [Bun](https://bun.sh) (runtime and package manager)
- `readpst` (from `libpst`) — must be on `$PATH`
- WeasyPrint — must be installed for PDF generation
- An OpenAI API key

---

## Environment Variables

Create a `.env.local` file in the project root:

```env
OPENAI_API_KEY=sk-...
DATABASE_PATH=/path/to/pst_analyzer.db
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
bun install
```

Run the development server:

```bash
bun dev
```

Open [http://localhost:3000](http://localhost:3000) to access the UI. Batch polling and background workers are managed automatically by the app — no separate cron process is required.

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
    ai.ts                  # OpenAI batch file generation
    analyzer.ts            # PST extraction and email deduplication
    batch-worker.ts        # Batch result polling and DB updates
    batch-scheduler.ts     # In-server self-stopping AI batch poller
    standalone-processor.ts# Files phase engine (Teams messages + documents)
    converter.ts           # WeasyPrint-based PDF conversion
    db.ts                  # SQLite schema and connection (Bun SQLite)
    exporter.ts            # Email parsing and content extraction
    purger.ts              # Cleanup utilities
    staging.ts             # Staging scanner + stale-row pruning
    types.ts               # Shared TypeScript types

# Background workers (repo root, run under Bun as detached child processes)
convert-worker.ts   # PDF rendering for the Render phase
files-worker.ts     # Files phase processor (spawned by /api/files-process)
office-worker.ts    # Isolates synchronous DOCX/XLSX parsing off the main loop
batches/            # Ephemeral JSONL files for OpenAI batch uploads (gitignored)
```

---

## Tech Stack

- **Next.js 16** (App Router, `--webpack`)
- **Bun** — runtime, SQLite driver (`bun:sqlite`, WAL mode)
- **OpenAI Batch API** — async AI triage at scale
- **WeasyPrint** — HTML-to-PDF rendering
- **Tailwind CSS v4**
- **Biome** — linting and formatting
