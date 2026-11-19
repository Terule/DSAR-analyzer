/**
 * The one second review (docs/pipeline-refactor.md, section 5): a Haiku 4.5
 * discard that shows doubt is asked again to Haiku 5.5 (Converse). What differs
 * between emails and files is only what a row is and what a failure means, so
 * each supplies an adapter and this runner does the rest: reclaim claims left by
 * a dead worker, resolve the Converse client, claim waiting rows atomically in
 * chunks, settle them with bounded concurrency inside a time budget, and never
 * strand a row when AWS credentials are missing.
 */
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { converseConcurrency } from "./bedrock/config";
import { awsBedrockDeps } from "./bedrock/files-ai-client";
import type { ParsedRequest } from "./bedrock/translate";

/** A claim older than this was left by a worker that died; it is queued again. */
export const STALE_RUNNING_MS = 15 * 60_000;
/** Without AWS credentials for this long, waiting rows are settled the safe way. */
export const NO_CREDENTIALS_GIVE_UP_MS = 30 * 60_000;
/** Rows claimed per round. */
export const CLAIM_CHUNK = 200;
/** One call works through the backlog for at most this long, then yields to the sweep. */
export const TIME_BUDGET_MS = 90_000;

export type Converse = (
  request: ParsedRequest,
  modelId: string,
) => Promise<unknown>;

export interface SecondReviewOptions {
  /** One Converse call with a forced tool; defaults to AWS Bedrock. */
  converse?: Converse;
  timeBudgetMs?: number;
}

export interface SecondReviewAdapter<Row> {
  /** Log label. */
  name: string;
  /** A converse injected by tests for this kind of item, when there is one. */
  testConverse?: Converse;
  /** Rows claimed before this time by a worker that died go back to pending. */
  reclaimStale(cutoff: Date): Promise<void>;
  /**
   * No credentials: settle the rows that have waited since before `cutoff` the
   * safe way for this kind of item. Returns how many were settled.
   */
  giveUpWithoutCredentials(cutoff: Date): Promise<number>;
  /**
   * Claims up to `take` pending rows (oldest first) and returns them; an empty
   * list when another worker won them all; null when nothing waits.
   */
  claim(take: number, stamp: Date): Promise<Row[] | null>;
  /** Settles one claimed row; must never throw and must clear the claim. */
  settle(row: Row, converse: Converse): Promise<void>;
  /** After the loop, whatever the adapter has to do about the rows it touched. */
  finish(): Promise<void>;
}

export async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

async function resolveConverse(
  explicit: Converse | undefined,
): Promise<Converse | undefined> {
  if (explicit) return explicit;
  try {
    await defaultProvider()();
    return awsBedrockDeps().converse;
  } catch {
    return undefined;
  }
}

/** Runs the second review for one kind of item. Returns how many rows were settled. */
export async function runSecondReview<Row>(
  adapter: SecondReviewAdapter<Row>,
  options: SecondReviewOptions = {},
): Promise<number> {
  const started = Date.now();
  await adapter.reclaimStale(new Date(started - STALE_RUNNING_MS));

  const converse = await resolveConverse(
    options.converse ?? adapter.testConverse,
  );
  let settled = 0;

  if (!converse) {
    settled += await adapter.giveUpWithoutCredentials(
      new Date(started - NO_CREDENTIALS_GIVE_UP_MS),
    );
  } else {
    const budget = options.timeBudgetMs ?? TIME_BUDGET_MS;
    while (Date.now() - started < budget) {
      const rows = await adapter.claim(CLAIM_CHUNK, new Date());
      if (rows === null) break;
      await mapLimit(rows, converseConcurrency(), async (row) => {
        await adapter.settle(row, converse);
        settled++;
      });
    }
  }

  await adapter.finish();
  return settled;
}
