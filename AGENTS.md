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

- **Database**: Bun SQLite (`bun:sqlite`) at the path set by `DATABASE_PATH` env var.
- **AI**: OpenAI Batch API (`gpt-4o-mini`) via `src/lib/ai.ts`. Do not switch to streaming/realtime calls.
- **PDF**: WeasyPrint-based pipeline in `src/lib/converter.ts`. Do not reintroduce Puppeteer.
- **Email extraction**: `readpst` (libpst) + `mailparser`. All EML logic lives in `src/lib/analyzer.ts` and `src/lib/exporter.ts`.
- **Environment variables**: `OPENAI_API_KEY`, `DATABASE_PATH`, `STAGING_PATH`, `EXTRACTED_PATH` — always read from `process.env`, never hardcode paths.
- **No hardcoded absolute paths** in committed code.

---

## File Structure

```
src/
  app/           # App Router: pages, layouts, API route handlers
  components/    # React client/server components
  lib/           # Business logic (no React)
batches/         # Ephemeral JSONL files for OpenAI batch uploads (gitignored)
```
<!-- END:nextjs-agent-rules -->
