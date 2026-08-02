import { BullmqQueueAdapter } from "@/lib/queue/bullmq-adapter";
import type { OrchestratorQueueAdapter } from "@/lib/queue/types";

export type QueueProvider = "bullmq";

let adapter: OrchestratorQueueAdapter | null = null;

export function resolveQueueProvider(): QueueProvider {
  return "bullmq";
}

export function getQueueAdapter(): OrchestratorQueueAdapter {
  if (adapter) return adapter;
  adapter = new BullmqQueueAdapter();
  return adapter;
}

export async function closeQueueAdapter(): Promise<void> {
  if (!adapter) return;
  const ref = adapter;
  adapter = null;
  await ref.close();
}
