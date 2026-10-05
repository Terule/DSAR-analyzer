# Request waves (multi-part requests) — design

Date: 2026-10-05
Status: draft, awaiting review

## Goal

Let one request be processed in **waves** so a case larger than the machine's
disk (1 TB) can be handled in parts, with a single coherent, deduplicated
output folder. A completed request can be **continued**: new sources (PSTs
and/or Files) are added to the same staging folders and run as the next wave.
Output goes to the same `[case]/[request]/{Emails,Messages,Documents}` folder.

Single-wave requests (mail, files, both) behave exactly as today.

## Decisions (agreed)

- Approach B: one request run in waves (not separate linked requests).
- Cross-wave duplicate check runs at **Extract**, before AI and Render.
- Numbering continues from the last delivered `Email NNNN`.
- "R1 mail + R1 files into one folder" = continue a mail request with a Files
  wave (or the reverse). No second request.
- Deleting a finished wave's PSTs by hand must be safe; there is no separate
  "release sources" step.
- Reset means starting over (all waves, hashes and output).
- Out of scope: Files content-dedup across waves (Files dedup stays within one
  run), moving outputs, per-request staging roots.

## Current state that matters

- Dedup: `email_hash = sha256("[case]/[request]/PST" :: messageId-or-fallback)`
  (`analyzer.ts`); a duplicate is detected against any persisted `emails` row
  with that hash. Same request => same scope across waves, so cross-wave dedup
  needs no new hashing, only that the rows survive.
- `scanRequestSources` (`cases.ts`) deletes all of the request's
  `processed_files` and recreates them on every Run.
- `pruneMissingRows` (`staging.ts`, called from `/api/files`) deletes any
  `processed_files` row, and its `emails`, whose file is gone.
- Render (`converter.ts`) names PDFs `Email {idx+1}`, skips a PDF that already
  exists (resume), and removes the hidden `.work` tree after success.
  `Warning NNN` uses the same scheme. Warning records are selected through
  `getCasePstFileIds` (all PST rows of the request).
- The coordinator and "settled" checks (`case-utils.ts`) select PST rows by
  request key.

## Design

### 1. Data model (one migration)

- `ProcessedFile.wave Int @default(1)`
- `CaseRequest.wave Int @default(1)` — current wave
- `CaseRequest.wave_scope String?` — what the current wave contains
  (`mail | files | both`)
- `CaseRequest.render_base Int?` — highest `Email` number before the current
  wave's first Render
- `CaseRequest.warning_base Int?` — same for `Emails/Warning/Warning NNN`, so a
  Render retry numbers warnings identically

Defaults leave all existing data and behavior unchanged.

### 2. Lifecycle

- `POST /api/requests/[id]/continue` `{ add: "mail" | "files" | "both" }`:
  requires `completed`; `wave += 1`; sets `wave_scope`; widens `scope` to the
  union of previous scope and `add`; creates missing `PST/`, `Files/`,
  `Messages/`, `Documents/` folders; status -> `ready`; clears `render_base`.
- **Run** (`scanRequestSources`): replaces only rows of the current wave; row
  ids for wave 1 keep the existing hash, later waves include the wave number;
  validates sources against `wave_scope` instead of the full `scope`.
- A failed wave can be Run again. The re-run removes only that wave's source
  and email rows, deletes any output numbered above `render_base`, and resets
  `render_base`.
- **Reset**: deletes all waves' rows, hashes and output; `wave = 1`; clears
  `wave_scope` and `render_base`. For wave > 1 the UI asks for a stronger
  confirmation ("removes all waves; cannot be re-created").
- Continue, Run and Reset stay blocked while `queued`, `running` or `stopping`.
  Waves are strictly sequential (existing per-request admission key).

### 3. Dedup and prune protection

- Cross-wave dedup relies on persisted `emails` rows (see Current state).
- `pruneMissingRows` keeps a source row that belongs to a managed request
  (`case_request_id` set), and its `emails`, once it has finished rendering (`pdf_status = completed` for PST rows,
  `files_status = completed` for the Files row), and skips the
  `source_deleted` history snapshot for them. Rows that vanish before finishing
  are pruned as today. Deleting a finished wave's PSTs is therefore safe.
- Coordinator selection, `getCasePstFileIds` and `isCaseAiSettled` are scoped
  to the row's request **and wave**. Legacy rows (wave 1) behave as before.

### 4. Numbering (Render)

- At a wave's first Render, if `render_base` is unset, set it to the highest
  `N` found in `Emails/` matching `^Email (\d+)\b` (files and attachment
  folders). A retry reuses the stored value, so resume still produces the same
  numbers.
- PDF number = `render_base + idx + 1`. Digit width =
  `max(existing width, digits of the final number)`; existing files are never
  renamed.
- `Warning NNN` uses the same rule with its own base taken from
  `Emails/Warning/`, and its record query is scoped to the current wave.
- The `existsSync` skip stays as the resume mechanism; with offset numbers it
  can no longer skip another wave's files.

### 5. UI and aggregation

- Request card: **Wave N** badge; **Continue** (opens "Add Email / Files /
  Both") when `completed`.
- `phaseProgress` / `phaseTiming` in `api/cases/route.ts` use the current
  wave's rows; header totals (emails exported, deliverable files) stay
  cumulative.
- SharePoint upload needs no change: artifacts are keyed by local path, so only
  new files are queued; progress sums over rows.

## Files touched (approximate)

`prisma/schema.prisma` + migration, `src/lib/cases.ts`, `src/lib/case-utils.ts`,
`src/lib/converter.ts`, `src/lib/staging.ts`, `src/app/api/cases/route.ts`,
`src/app/api/requests/[requestId]/reset/route.ts`, new
`src/app/api/requests/[requestId]/continue/route.ts`,
`src/components/dashboard/CaseManager.tsx`.

## Risks and notes

- Reset past wave 1 is destructive and cannot be regenerated once earlier
  waves' PSTs are deleted (accepted).
- If a count crosses a digit boundary (9999 -> 10000) earlier files keep the
  shorter width; natural sort still orders them.
- Plan-time clarifications: output cleanup of a failed wave's leftovers applies
  to wave > 1 only (wave 1 keeps today's resume-by-existing-PDF behavior);
  Warning records are rendered in a deterministic order (`email_hash`) so
  retry numbering is stable.
- Wave > 1 rows share the request key `[case]/[request]` with wave 1; any code
  that groups by that key alone must be checked for wave scoping (plan task).

## Verification

- `tsx` script for pure logic: max-number parsing, base/width, prune-protection
  predicate.
- Database-level checks with fake rows: wave-scoped coordinator selection and
  the prune rule.
- User-run smoke test on a small case: two tiny PSTs with one duplicated email;
  confirm wave 2 numbering continues, the duplicate is dropped, and deleting
  wave 1's PST does not remove its hashes.
- `tsc --noEmit`, `biome check`.
