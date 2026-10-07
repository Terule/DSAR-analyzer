# Files AI relevance check — design

Date: 2026-10-07
Status: draft for review

## Purpose

Emails go through an AI relevance audit (OpenAI Batch, `gpt-4o-mini`); files
(Teams messages and loose documents, the `Files` phase) do not. They are kept by
rules only: the subject is mentioned, content dedup, privileged keywords. This
adds an AI relevance pass for files so irrelevant ones are not delivered or
uploaded.

## Agreed decisions

- Discarded files count as skipped; large files are judged from a sample and,
  when it matches, kept as is (details below).

- **Verdict**: a file the AI judges not relevant is **excluded from delivery**
  (not delivered, not uploaded). It is kept on disk under `Discarded/` with the
  AI's reason so a reviewer can audit it.
- **Scope**: all cases by default, with a switch in the System settings menu
  (like "Delete source PSTs"). **Client cases never run it**: they are
  dedup-only, bypass the filters and never upload.
- **JW R1**: not re-judged. This applies to future Files runs only.
- **Approach**: a new, isolated Files-AI module and tables. It reuses the OpenAI
  Batch client, token budgeting and the in-server poller, but does not touch the
  email AI tables or code.
- High recall is the goal: the pass may only remove a file on an explicit
  `discard`. Every error path delivers the file.

## Constraints from the project

- OpenAI **Batch API only** (no realtime/streaming), `gpt-4o-mini`.
- Prisma-native queries, no raw SQL; atomic claims with `updateMany` + `count`.
- Polling stays in the in-server poller (`batch-scheduler.ts`); no new cron.
- Files are numbered only in `finalizeStandaloneDeliverables`, so excluding
  files before finalize leaves no numbering gaps.
- Settings live in `PipelineSettings` and the System settings dialog, not `.env`.

## Where it fits

```
Files batches (convert) → settle → [Files AI audit] → finalize → upload
```

`settleFilesBatches` (dispatcher) currently enqueues the finalize job once every
batch and fallback job has settled. With the setting on (and a non-client case),
it enqueues a **Files AI prepare** step first; finalize is enqueued only after
the AI step is settled.

## Components

### 1. Excerpt sidecars (written during conversion)

For every file kept and converted, the conversion batch writes a small JSON
sidecar under the request's hidden work path
(`<case>/<request>/.work/Files/ai-excerpts/<contentHash>.json`):

```
{ id, deliverablePath, sourceName, type, excerpt }
```

- `excerpt`: the first ~4,000 characters of the extracted text plus the lines
  that mention the subject (capped overall). The text is already in memory at
  conversion time, so no extra extraction pass is needed.
- **Large files** (the existing large-Office threshold, and any file whose full
  text would exceed the per-file token budget) are never sent whole. Only a
  **sample** goes to the AI: the head of the text plus the lines that mention the
  subject, spread across the file and capped. The verdict applies to the whole
  file. If the sample matches the criteria (`keep`), the file is **kept exactly
  as it is**: delivered through the normal path, unchanged and with no further
  AI calls. Only an explicit `discard` removes it.
- Files delivered as unconverted originals (fallback) that cannot yield text
  are kept without an AI verdict.

### 2. Tables (new migration)

- `files_ai_verdicts`: `id`, `file_id` (the Files row), `item_id` (content hash),
  `deliverable_path`, `verdict` (`keep` | `discard` | null while pending),
  `reason`, `batch_run_id`, `created_at`.
- `files_ai_batch_runs`: mirrors `ai_batch_runs` (`coordinator_id`,
  `openai_batch_id` unique, `status`, `request_count`, `estimated_tokens`,
  `retry_count`, `error`, timestamps).
- `PipelineSettings.files_ai_enabled Boolean @default(true)`.

### 3. `src/lib/files-ai.ts`

- `buildFilesAiBatches`: reads sidecars, chunks by the existing
  `ai_max_tokens_per_batch`, honours `ai_max_concurrent_batches` (shared slot
  budget with emails), writes JSONL under `batches/`, submits.
- Prompt: the same subject criteria as the email audit. Returns strict JSON
  `{ verdict: "keep" | "discard", reason }` per file. Discard only when the file
  is clearly not about, authored by or involving the subject.
- `applyFilesAiBatchOutput`: stores verdicts. Missing, malformed or ambiguous
  output for an item leaves its verdict `keep`.
- `isFilesAiSettled(fileId)`: true when no batch is in flight and every item has
  a verdict or was resolved to keep after retries.

### 4. Poller integration

`runBatchSweep` also polls submitted `files_ai_batch_runs` and keeps polling
while Files-AI work remains. Restart recovery follows the email pattern
(stale `processing` runs return to `submitted`).

### 5. Apply and finalize

Job `filesAiApply` (run by the control plane when the AI step is settled):

1. Move every `discard` deliverable to `<request>/Discarded/Documents|Messages/`.
2. Write `Discarded/verdicts.csv` (file, type, verdict, reason).
3. Enqueue the existing finalize job, which numbers what remains and queues
   upload.

### 6. Failure behaviour

- Batch submit/poll failure after retries: items stay `keep`; the run proceeds
  to finalize and logs a warning (no blocked delivery).
- Retry: the retry flow for a failed Files step re-runs the AI step
  idempotently (existing verdicts are reused, only pending items are resubmitted).

### 7. UI and settings

- System settings → "AI relevance check for files" toggle (default on).
- Files tile shows an "AI audit" sub-state with batches done/total while running.
- `Discarded/` is excluded from upload by construction (it is outside
  `Messages/` and `Documents/`).

## Testing

- Unit: excerpt building, prompt/response parsing (malformed → keep), chunking.
- DB tests: verdict storage, settled-state logic, idempotent re-run, client-case
  skip, setting off skips the step.
- Integration with a stubbed OpenAI client: discard moves to `Discarded/`,
  finalize numbers without gaps, upload list excludes `Discarded/`.
- Rehearsal on a copy of JW's converted output before enabling by default.

## Out of scope

- Re-judging already delivered runs (JW R1).
- Changing the email AI.
- A confidence threshold (verdict is binary; can be added later).
- AWS Bedrock migration.

## Open items to settle in the plan

- Exact excerpt size cap and token budget per file.
- Whether Discarded files count toward the "skipped" tile total.
