# PST Analyser

A Next.js web application for performing **Data Subject Access Request (DSAR)** compliance audits on PST/email archives.

It ingests `.pst` files, extracts and deduplicates emails, runs an AI-powered relevance filter against a named data subject, and produces a PDF export of the kept emails.

---

## How It Works

The pipeline runs in stages, each tracked in a SQLite database:

1. **Scan** — PST files are detected from a configurable staging directory.
2. **Analyse** — `readpst` extracts emails as `.eml` files. Each email is parsed, hashed, and deduplicated. Attachments are inventoried.
3. **AI Triage** — Emails are sent in batches to the OpenAI Batch API (`gpt-4o-mini`). The model applies hard DSAR rules (exact email match, name/alias signals, privileged-subject discards) and returns `keep` / `discard` per email.
4. **PDF Export** — Kept emails and their attachments (DOCX, XLSX, PDF) are rendered to PDF via WeasyPrint and merged into a single output document.

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

## Getting Started

Install dependencies:

```bash
bun install
```

Run the development server:

```bash
bun dev
```

Open [http://localhost:3000](http://localhost:3000) to access the UI.

---

## Project Structure

```
src/
  app/           # Next.js App Router pages and API routes
  components/    # React UI components
  lib/
    ai.ts            # OpenAI batch file generation
    analyzer.ts      # PST extraction and email deduplication
    batch-worker.ts  # Batch result polling and DB updates
    converter.ts     # WeasyPrint-based PDF conversion
    db.ts            # SQLite schema and connection (Bun SQLite)
    exporter.ts      # Email parsing and content extraction
    purger.ts        # Cleanup utilities
    staging.ts       # Staging directory scanner
    types.ts         # Shared TypeScript types
batches/         # Temporary JSONL files for OpenAI batch uploads
```

---

## Tech Stack

- **Next.js 16** (App Router)
- **Bun** — runtime, SQLite driver
- **OpenAI Batch API** — async AI triage at scale
- **WeasyPrint** — HTML-to-PDF rendering
- **Tailwind CSS v4**
- **Biome** — linting and formatting
