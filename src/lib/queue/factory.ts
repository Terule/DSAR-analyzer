import { BullmqQueueAdapter } from "@/lib/queue/bullmq-adapter";
import { SqsQueueAdapter } from "@/lib/queue/sqs-adapter";
import type { OrchestratorQueueAdapter } from "@/lib/queue/types";

export type QueueProvider = "bullmq" | "sqs";

let adapter: OrchestratorQueueAdapter | null = null;

export function resolveQueueProvider(): QueueProvider {
  const raw = (process.env.QUEUE_PROVIDER || "bullmq").toLowerCase();
  if (raw === "sqs") return "sqs";
  return "bullmq";
}

export function getQueueAdapter(): OrchestratorQueueAdapter {
  if (adapter) return adapter;
  const provider = resolveQueueProvider();
  adapter =
    provider === "sqs" ? new SqsQueueAdapter() : new BullmqQueueAdapter();
  return adapter;
}

export async function closeQueueAdapter(): Promise<void> {
  if (!adapter) return;
  const ref = adapter;
  adapter = null;
  await ref.close();
}
